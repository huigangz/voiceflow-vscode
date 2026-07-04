// VoiceFlow native helper(方案 B,spec D7 备用路线 → S1 Webview No-Go 后转正)
//
// 职责:winmm waveIn 采集 16kHz 单声道 16-bit PCM,原始字节流写 stdout。
// 协议:
//   stdout : s16le PCM 流(无头)
//   stderr : 诊断行;"ERROR <code> <detail>" 为致命错误
//   stdin  : 关闭(EOF)= 停止采集,helper 冲刷缓冲后 exit 0
//   退出码 : 0 正常;2 无设备;3 打开失败(含隐私设置拒绝);4 采集中设备错误
//
// 编译(仅用系统自带 .NET Framework 4.8,零依赖):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:bin\voiceflow-mic.exe helper\MicCapture.cs
//
// 设计说明:waveInOpen 使用 CALLBACK_EVENT + 独立处理线程轮询 WHDR_DONE,
// 避免官方文档禁止的"在 waveIn 回调内调用系统函数"死锁问题(与 NAudio WaveInEvent 同构)。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class MicCapture
{
    const int SAMPLE_RATE = 16000;
    const int CHANNELS = 1;
    const int BITS = 16;
    const int BUFFER_MS = 100;                                // 每缓冲 100ms
    const int BUFFER_BYTES = SAMPLE_RATE * (BITS / 8) * CHANNELS * BUFFER_MS / 1000;
    const int BUFFER_COUNT = 8;

    const uint CALLBACK_EVENT = 0x00050000;
    const uint WAVE_MAPPER = unchecked((uint)-1);
    const int WHDR_DONE = 0x00000001;
    const int MMSYSERR_NOERROR = 0;
    const int MMSYSERR_BADDEVICEID = 2;
    const int MMSYSERR_ALLOCATED = 4;
    const int MMSYSERR_NODRIVER = 6;

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength, dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags, dwLoops;
        public IntPtr lpNext, reserved;
    }

    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr hwi, uint uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, uint fdwOpen);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr hwi);
    [DllImport("winmm.dll")] static extern int waveInStop(IntPtr hwi);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr hwi);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr hwi);

    static volatile bool stopping;

    static int Main()
    {
        if (waveInGetNumDevs() == 0)
        {
            Console.Error.WriteLine("ERROR no-device no audio input devices");
            return 2;
        }

        var fmt = new WAVEFORMATEX
        {
            wFormatTag = 1, // PCM
            nChannels = CHANNELS,
            nSamplesPerSec = SAMPLE_RATE,
            wBitsPerSample = BITS,
            nBlockAlign = CHANNELS * BITS / 8,
            nAvgBytesPerSec = SAMPLE_RATE * CHANNELS * BITS / 8,
            cbSize = 0,
        };

        var dataReady = new AutoResetEvent(false);
        IntPtr hwi;
        int rc = waveInOpen(out hwi, WAVE_MAPPER, ref fmt,
            dataReady.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CALLBACK_EVENT);
        if (rc != MMSYSERR_NOERROR)
        {
            string code = (rc == MMSYSERR_BADDEVICEID || rc == MMSYSERR_NODRIVER) ? "no-device"
                        : (rc == MMSYSERR_ALLOCATED) ? "device-busy"
                        : "open-failed"; // 含 Windows 隐私设置拒绝
            Console.Error.WriteLine("ERROR " + code + " waveInOpen rc=" + rc);
            return 3;
        }

        // 分配并投递缓冲
        var headers = new IntPtr[BUFFER_COUNT];
        var buffers = new IntPtr[BUFFER_COUNT];
        int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
        for (int i = 0; i < BUFFER_COUNT; i++)
        {
            buffers[i] = Marshal.AllocHGlobal(BUFFER_BYTES);
            var h = new WAVEHDR { lpData = buffers[i], dwBufferLength = BUFFER_BYTES };
            headers[i] = Marshal.AllocHGlobal(hdrSize);
            Marshal.StructureToPtr(h, headers[i], false);
            waveInPrepareHeader(hwi, headers[i], hdrSize);
            waveInAddBuffer(hwi, headers[i], hdrSize);
        }

        var stdout = Console.OpenStandardOutput();
        var managed = new byte[BUFFER_BYTES];
        int exitCode = 0;

        // 停止信号:stdin EOF(extension 端 stdin.end())
        var stdinWatcher = new Thread(() =>
        {
            var stdin = Console.OpenStandardInput();
            var one = new byte[1];
            while (stdin.Read(one, 0, 1) > 0) { /* 忽略内容,只等 EOF */ }
            stopping = true;
            dataReady.Set();
        }) { IsBackground = true };
        stdinWatcher.Start();

        rc = waveInStart(hwi);
        if (rc != MMSYSERR_NOERROR)
        {
            Console.Error.WriteLine("ERROR open-failed waveInStart rc=" + rc);
            return 3;
        }
        Console.Error.WriteLine("READY rate=" + SAMPLE_RATE + " channels=" + CHANNELS + " bits=" + BITS);

        try
        {
            while (!stopping)
            {
                dataReady.WaitOne(1000);
                for (int i = 0; i < BUFFER_COUNT; i++)
                {
                    var h = (WAVEHDR)Marshal.PtrToStructure(headers[i], typeof(WAVEHDR));
                    if ((h.dwFlags & WHDR_DONE) == 0) continue;
                    if (h.dwBytesRecorded > 0)
                    {
                        Marshal.Copy(h.lpData, managed, 0, (int)h.dwBytesRecorded);
                        stdout.Write(managed, 0, (int)h.dwBytesRecorded);
                        stdout.Flush();
                    }
                    if (stopping) continue;
                    // 重新投递(在自有线程调用,合法)
                    h.dwFlags &= unchecked((uint)~WHDR_DONE);
                    h.dwBytesRecorded = 0;
                    Marshal.StructureToPtr(h, headers[i], false);
                    rc = waveInAddBuffer(hwi, headers[i], hdrSize);
                    if (rc != MMSYSERR_NOERROR)
                    {
                        Console.Error.WriteLine("ERROR device-lost waveInAddBuffer rc=" + rc);
                        exitCode = 4;
                        stopping = true;
                    }
                }
            }
        }
        finally
        {
            waveInStop(hwi);
            waveInReset(hwi); // 归还所有未完成缓冲
            for (int i = 0; i < BUFFER_COUNT; i++)
            {
                waveInUnprepareHeader(hwi, headers[i], hdrSize);
                Marshal.FreeHGlobal(headers[i]);
                Marshal.FreeHGlobal(buffers[i]);
            }
            waveInClose(hwi);
            stdout.Flush();
        }
        return exitCode;
    }
}
