// P2c:自研 voiceflow-audio.node —— miniaudio WASAPI loopback 采集(正式实现)。
//
// 范围决策(worklog p2c1):本期仅 loopback;mic 路径保持 PvRecorder(已验证闭环,
// 私有哈希 .node 的 SAC 风险不引入 mic);"统一采集"终局待 D5 签名落地。
//
// 设计(与 2a 驱动 pvrecorder 的轮询模式同构,JS 单线程契约同 2a):
// - 环形缓冲(上限 8s 原生音频)+ 溢出计数:JS 侧 ~100ms 节拍 read,8s 余量
//   覆盖长挂起;溢出即计数(数据丢弃可观测,JS 侧据此报 device-lost 级错误)
// - ma 停止通知 → stopped 标志:设备失效(默认渲染设备切换/移除)可被 JS 轮询发现
// - read() 排空缓冲返回 Float32Array(交错原生格式);无数据返回空数组,不阻塞
// - stop() 幂等同步(ma_device_uninit 内含线程 join;JS 单线程无并发调用)
// - "无渲染流无包"为 WASAPI 语义(双实现确证),静音填充归 JS 层 GapFiller(可单测)
//
// 构建:node scripts/build-audio-addon.mjs(node-gyp rebuild + 拷贝 prebuilt/)
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_DECODING
#define MA_NO_GENERATION
#include "miniaudio.h"
#include <napi.h>
#include <mutex>
#include <vector>
#include <cstring>

namespace {

constexpr size_t kMaxBufferedSeconds = 8;

ma_device g_device;
bool g_running = false;
volatile bool g_deviceStopped = false; // ma 通知线程写,JS 线程读
std::mutex g_mutex;
std::vector<float> g_buf;
ma_uint32 g_channels = 0;
ma_uint32 g_rate = 0;
ma_uint64 g_overflowFrames = 0;

void data_callback(ma_device* dev, void* out, const void* in, ma_uint32 frames) {
    (void)dev; (void)out;
    if (in == NULL) return;
    const float* f = (const float*)in;
    std::lock_guard<std::mutex> lock(g_mutex);
    size_t cap = (size_t)g_rate * g_channels * kMaxBufferedSeconds;
    size_t n = (size_t)frames * g_channels;
    if (g_buf.size() + n > cap) {
        g_overflowFrames += frames; // 满则丢并计数(JS 侧可观测,绝不静默)
        return;
    }
    g_buf.insert(g_buf.end(), f, f + n);
}

void notification_callback(const ma_device_notification* pNotification) {
    if (pNotification->type == ma_device_notification_type_stopped && g_running) {
        g_deviceStopped = true; // 仅 running 期间的停止 = 设备失效(主动 stop 先清 running,不误报)
    }
}

Napi::Value StartLoopback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (g_running) {
        Napi::Error::New(env, "loopback already running").ThrowAsJavaScriptException();
        return env.Null();
    }
    g_deviceStopped = false;
    g_overflowFrames = 0;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_buf.clear();
    }
    ma_device_config cfg = ma_device_config_init(ma_device_type_loopback);
    cfg.capture.format = ma_format_f32;
    cfg.capture.channels = 0; // native
    cfg.sampleRate = 0;       // native
    cfg.dataCallback = data_callback;
    cfg.notificationCallback = notification_callback;
    ma_result r = ma_device_init(NULL, &cfg, &g_device);
    if (r != MA_SUCCESS) {
        Napi::Error::New(env, std::string("ma_device_init failed: ") + ma_result_description(r))
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    g_channels = g_device.capture.channels;
    g_rate = g_device.sampleRate;
    r = ma_device_start(&g_device);
    if (r != MA_SUCCESS) {
        ma_device_uninit(&g_device);
        Napi::Error::New(env, std::string("ma_device_start failed: ") + ma_result_description(r))
            .ThrowAsJavaScriptException();
        return env.Null();
    }
    g_running = true;
    Napi::Object o = Napi::Object::New(env);
    o.Set("sampleRate", Napi::Number::New(env, g_rate));
    o.Set("channels", Napi::Number::New(env, g_channels));
    return o;
}

Napi::Value Read(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::vector<float> local;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        local.swap(g_buf);
    }
    Napi::Float32Array arr = Napi::Float32Array::New(env, local.size());
    if (!local.empty()) memcpy(arr.Data(), local.data(), local.size() * sizeof(float));
    return arr;
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("running", Napi::Boolean::New(env, g_running));
    o.Set("deviceStopped", Napi::Boolean::New(env, g_deviceStopped));
    o.Set("overflowFrames", Napi::Number::New(env, (double)g_overflowFrames));
    return o;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (g_running) {
        g_running = false;            // 先清标志:通知回调据此区分主动停 vs 设备失效
        ma_device_uninit(&g_device);  // 同步,内含采集线程 join
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    g_buf.clear();
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startLoopback", Napi::Function::New(env, StartLoopback));
    exports.Set("read", Napi::Function::New(env, Read));
    exports.Set("getStatus", Napi::Function::New(env, GetStatus));
    exports.Set("stop", Napi::Function::New(env, Stop));
    return exports;
}

} // namespace

NODE_API_MODULE(voiceflow_audio, Init)
