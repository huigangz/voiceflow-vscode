// 测试夹具:模拟设备拔出后 winmm 静默挂起的 helper —— 发 READY 后不再产数据也不退出。
// 用于验证 HelperRecorder 的数据流 watchdog 能判定 device-lost。
using System;
using System.Threading;

static class SilentHelper
{
    static int Main()
    {
        Console.Error.WriteLine("READY rate=16000 channels=1 bits=16");
        Thread.Sleep(30000); // 静默挂起(不发 stdout,不退出)
        return 0;
    }
}
