# fish-voice-server

Fish 对话音声的配套服务端插件。

## 为什么需要它

一次性克隆（one-shot cloning）要把参考音频随请求一起传给 Fish，而：

- `/v1/tts` 的响应格式只接受 `application/json` 和 `application/msgpack`；
- 内联 `references` 字段**只支持 MessagePack**，JSON 会被拒；
- 浏览器直连 `api.fish.audio` 会被 CORS 拦死（Fish 不返回 `Access-Control-Allow-Origin`）；
- 酒馆的 `/proxy/` 在 `src/middleware/corsProxy.js` 里用 `JSON.stringify(req.body)` 转发，二进制必毁。

于是报错长这样：`invalid type: integer 123, expected struct TTSRequest`（`{` 的首字节 0x7B = 123）。

酒馆本身跑在 Node 上，没有这些限制。所以音频在浏览器里读成 base64，POST 给酒馆自己的插件路由，由插件用官方 SDK 完成编码与调用。

## 安装

```bash
cp -r server-plugin/fish-voice-server <SillyTavern>/plugins/
cd <SillyTavern>/plugins/fish-voice-server && npm install --omit=dev
```

然后**重启酒馆**。访问 `/api/plugins/fish-voice-server/status`，
看到 `{"ok":true,"sdk":"ready"}` 即安装成功。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins/fish-voice-server/status` | 健康检查，返回 SDK 是否可用 |
| POST | `/api/plugins/fish-voice-server/clone` | 一次性克隆合成，返回音频字节 |

`/clone` 请求体：`{ apiKey, baseUrl, model, text, format, transcript, mime, filename, audio }`，
其中 `audio` 是 base64（也接受 data URL）。失败时返回非 200 与 `{ error }`。

调用方必须带酒馆的 `X-CSRF-Token` 头，否则会被 CSRF 中间件拦成 403。
