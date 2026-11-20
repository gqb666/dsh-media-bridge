# dsh-media-bridge

DeepSeek Harness 插件：把图片、语音、视频任务交给**你自己配置**的多模态接口，让纯文本对话模型也能看图、听音、生成视频。

零依赖，Host-only + 一个 Web 表单，不含任何内置密钥或固定服务商。

## 为什么需要它

DSH 里切到纯文本模型（或第三方 OpenAI 兼容网关）后，图片无法进入上下文。这个插件提供一组工具，由模型主动把「提示词 + 文件路径」交给一个支持视觉/语音/视频的接口，再把结果带回对话。

三类能力可以指向**不同网关**：视觉与语音识别在一处、视频在另一处的服务（例如资源池分离的平台）可以同插件共存。

## 安装

在 DSH 的「插件」面板 → 添加插件，填入：

```
git+https://github.com/gqb666/dsh-media-bridge.git
```

也可以填本地目录路径，或在 profile 中安装：

```sh
pnpm add git+https://github.com/gqb666/dsh-media-bridge.git
```

## 配置

安装后打开侧边栏「插件」面板，点开 **Media bridge**（多模态桥接），页面中部即为表单：

| 字段 | 说明 |
|---|---|
| 接口地址 Base URL | OpenAI 兼容根路径，需含版本段，如 `https://api.example.com/v1` |
| API Key | 与「API Key 环境变量」二选一；填了 key 就优先用它 |
| API Key 环境变量 | 例如 `MEDIA_BRIDGE_API_KEY`，适合不想把密钥写进配置的场景 |
| 输出目录 | 生成的音频/视频保存位置，留空用系统临时目录 |
| 视觉 · 接口地址 / 模型 | 例如 `https://api.example.com/v1` + `Qwen2.5-VL-72B-Instruct` |
| 语音 · 识别 / 合成模型 | 例如 `SenseVoice` / `CosyVoice` |
| 视频 · 接口地址 / 模型 / 形态 | 模型如 `doubao-seedance-2.0`；形态见下文 |
| 触发条件 | 只在指定 provider/模型下暴露这些工具，支持 `*` |
| 工具开关 | 关闭不需要的能力，工具就不会出现在模型目录里 |

点「保存」后，插件通过 DSH 配置编辑器写入 profile 的 `cordis.patch.yml` 并重载自身，工具随新配置出现。「测试连接」会逐个探测填写的地址。

等价的手写配置（同一份数据，供不希望用表单的情况参考）：

```yaml
- id: media-bridge
  name: 'dsh-media-bridge'
  config:
    baseUrl: https://api.example.com/v1
    apiKey: sk-your-key
    outputDir: D:/out
    vision:
      model: Qwen2.5-VL-72B-Instruct
    speech:
      model: SenseVoice
      ttsModel: CosyVoice
    video:
      baseUrl: https://api.example.com/api/v3
      model: doubao-seedance-2.0
      style: volc
    trigger:
      providers: []
      models: []
```

## 工具

| 工具 | 参数要点 | 输出 |
|---|---|---|
| `media_vision` | `prompt` + `images[]`（本地绝对路径 / URL / data URI） | 视觉模型的文字回答 |
| `media_speech` | `operation: transcribe` + `audioPath`，或 `synthesize` + `text` | 文本，或音频文件绝对路径 |
| `media_video` | `prompt`，可选 `imagePath` / `videoPath` / `seconds` / `size` | 视频文件绝对路径 |
| `media_status` | `ping: true` 探测各 host | 生效配置与可达性 |

本地图片会转成 base64 data URI 内联发送；每次调用只发送提示词与显式引用的文件，不上传会话历史。

## 端点约定

- **视觉**：`POST {vision.baseUrl}/{vision.path}`（默认 `chat/completions`），`messages[0].content` 为文本 + `image_url`。
- **语音识别**：`POST {speech.baseUrl}/{speech.transcribePath}`（默认 `audio/transcriptions`），multipart 字段 `file`、`model`。
- **语音合成**：`POST {speech.baseUrl}/{speech.synthesizePath}`（默认 `audio/speech`），必须直接返回音频二进制；返回 JSON 任务文档时插件报错并给出 task_id，不会把 JSON 存成音频。
- **视频**：
  - `style: openai` → `POST {video.baseUrl}/{video.createPath}`（默认 `videos`），轮询 `videos/{id}`，下载 `videos/{id}/content`。
  - `style: volc` → `POST {video.baseUrl}/contents/generations/tasks`，请求体 `{model, content:[{type:'text',text},…]}`，轮询同路径 `/{id}`，完成时读 `content.video_url`。

路径都可在配置里用 `createPath` / `statusPath` / `contentPath` 覆盖，`{id}` 与 `{task_id}` 都会被替换为任务号。

## 参考：某云 MaaS 平台实测记录

用于说明这套抽象覆盖的真实差异（不同账号权限与开通状态结论会不同）：

| 能力 | 结果 |
|---|---|
| 视觉 `Qwen2.5-VL-72B-Instruct` | 可用，`/v1/chat/completions` 返回准确描述 |
| 识别 `SenseVoice` | 可用，`/v1/audio/transcriptions` 返回 `{"text":…}` |
| 合成 `CosyVoice` | `/v1/audio/tts/generate/transcriptions` 返回 `{task_id,status:PENDING}` 异步任务；`/v1/audio/speech` 为 404 |
| 视频 `minimax/minimax-h3-max` | 该账号下 `/v1/videos` 与 `/api/v3` 均 404 |
| 视频 `doubao-seedance-2.0` | 路由 `/api/v3/contents/generations/tasks` 存在，账号未订购时返回 403 |

## 触发条件

用户希望「只在我切到某个第三方模型时才把工具给模型看」时：

```yaml
trigger:
  providers: ['a2']            # 只在该 provider 生效
  models: ['a2/glm-5.3', '*flash*']   # provider/model 或裸模型名，支持 *
```

两者都留空表示所有模型可见。工具按能力独立注册：没填模型的类别不会出现在目录里。

## 局限

- 图片以 base64 内联发送，超大图会显著增大请求体，建议先压缩。
- 视频接口没有统一标准，插件实现两种常见形态；其他形态可借路径模板或中间网关适配。
- 异步任务型语音合成端点需要同步音频路由，或由调用方自行取结果。
- 关闭插件行后工具立即消失，已生成的文件仍保留在输出目录。

## 结构

```
index.js            Host 半：注册工具与配置路由
lib/config.js       配置归一（分组 baseUrl、路径模板、触发规则）
lib/tools.js        四个工具的 schema、请求与结果整形
lib/http.js         URL 拼接、鉴权、取消、错误截断
lib/media.js        MIME、图片编码、产物落盘
lib/config-api.js   表单读写通道（GET/POST /api/media-bridge）
client.js           Web 表单，注册到 plugins.bundle.config
cordis.patch.yml    插件行
locale/ docs/ icon  显示元数据与详情页
```

不依赖任何运行时库；表单用宿主提供的 React，样式只用 `--dsw-alias-*` 主题变量。

## License

MIT
