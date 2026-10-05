# cordis-plugin-local-dream

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-local-dream)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-local-dream)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-local-dream)](https://github.com/xinvxueyuan/cordis-plugin-local-dream)

Cordis（DeepSeek Harness）插件：让 agent 直接驱动 Android 应用 **Local Dream**（内置 HTTP 后端的 Stable Diffusion 应用）出图。
**默认走局域网直连（LAN）；局域网不可用时自动回退 USB（adb forward）；两者都不可用时按 `waitTimeoutMs` 轮询等待。**
在 "设备互联 / 主机模式" 下，插件还会自己驱动 8808 控制平面（`POST /select` 启动 8081 生成后端），因此"手机在跑但后端没起来"这种正常状态不会变成报错。

- 三个工具：`local_dream_api`（通用端点直通）、`local_dream_generate`（高层出图，直接落盘 PNG）、`local_dream_device`（连接与设备生命周期）。
- 只依赖 Node 内置能力（全局 `fetch`、`node:zlib`、`node:net`、`node:child_process`），**零运行时依赖**。
- SSE 增量解析 + 原始 RGB 像素校验 + 自研 PNG 编码器；图片字节不会进入模型上下文。

## 安装

在 profile 的 `cordis.patch.yml` 中插入（路径用绝对路径，loader 直接加载 TS 源码）：

```yaml
- insert:
    - id: local-dream
      name: 'file:///C:/dev/dsh/projects/cordis-plugin-local-dream/src/index.ts'
      config:
        mode: auto
```

重启后 agent 即可调用 `local_dream_api`、`local_dream_generate`、`local_dream_device`。

也可以按 npm 包安装：

```sh
dsh plugin add @xinvxueyuan/cordis-plugin-local-dream
```

```yaml
- insert:
    - id: local-dream
      name: '@xinvxueyuan/cordis-plugin-local-dream'
      config:
        mode: auto
```

## 配置（Config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto`：先 LAN 再 USB；`lan` / `usb` 强制单一传输 |
| `host` | `` | 手机局域网 IP/主机名；空 = 自动发现 |
| `port` | `8081` | 手机端生成后端端口 |
| `controlPort` | `8808` | 手机端 Device Link 控制平面端口；`0` = 关闭控制平面 |
| `localPort` | `0` | USB 转发本地端口；`0` = 优先 8081，被占用则挑空闲端口 |
| `adbPath` | `` | 显式 adb 可执行文件（指定即唯一候选，不做回退） |
| `bundledAdbDir` | `` | 覆盖内置 platform-tools 目录 |
| `serial` | `` | 目标设备 serial；多设备时必须显式指定（插件绝不猜测） |
| `autoSelect` | `true` | 后端未运行时，自动经 8808 `POST /select` 启动它 |
| `model` | `` | 要激活的 model_id；空 = 用 `/models` 目录里的第一个 |
| `selectWidth` | `0` | `/select` 宽度；`0` = 由模型 `generation_size` 推导，再兜底 512 |
| `selectHeight` | `0` | `/select` 高度；同上 |
| `waitTimeoutMs` | `120000` | 等不到连接的总预算（`0` = 快速失败） |
| `pollIntervalMs` | `2000` | 等待阶段的轮询间隔，也是控制平面状态轮询间隔 |
| `retryCount` | `3` | 调用中途断连的重连重试次数 |
| `retryDelayMs` | `2000` | 重连退避基数（`retryDelayMs * 2^n` + 抖动，封顶 30s） |
| `probeTimeoutMs` | `5000` | 单次探活/控制请求超时 |
| `requestTimeoutMs` | `300000` | 单请求的**静默**预算（SSE 按块判定，不是整体上限） |
| `discovery.enabled` | `true` | 是否扫本地网段找手机 |
| `discovery.concurrency` | `64` | 扫描并发 TCP 连接数 |
| `discovery.connectTimeoutMs` | `400` | 单次连接超时 |
| `discovery.maxHosts` | `1024` | 单次扫描主机上限（防失控） |
| `discovery.subnets` | `[]` | 显式 CIDR 列表，覆盖按网卡推导的 /24 |
| `outputDir` | `` | PNG 输出目录；空 = `<DSH_HOME 或 ~/.dsh>/outputs/local-dream` |

`assertConfig` 会拒绝：本该为正整数却非正的值、`port`/`controlPort`/`localPort` 超出 0–65535、未知 `mode`。

## 工具

### `local_dream_api`（通用端点直通）

- `endpoint`（必填）：不带前导斜杠，如 `generate`、`tokenize`、`health`，或控制平面的 `info`/`models`/`status`/`select`/`stop`
- `method`：`GET` / `POST` / `HEAD`（默认 `POST`，与 Local Dream 的业务端点一致）
- `query`：查询参数对象（仅扁平标量，嵌套值会被拒绝）
- `body`：JSON 请求体
- `raw`：以原始文本返回响应体（这是拿到**未经处理 SSE 流**的方式）
- `includeImage`：`true` 时内联 base64 图片；默认把每个 `image` 字段替换为 `{ imageBytes, width, height, channels }`
- `port`：单次调用覆盖端口（仅 LAN 传输支持；访问控制平面请显式传 `port: 8808`）
- `transport` / `host`：单次调用覆盖传输方式 / 局域网主机

`text/event-stream` 响应会被解析成 `{ events, complete, done, warnings }`；非 2xx 抛结构化错误（`raw: true` 时照原样返回文本）。

### `local_dream_generate`（高层出图）

参数与 `POST /generate` 文档字段一一对应：`prompt`（必填）、`negative_prompt`、`steps`、`cfg`、`seed`、`scheduler`（白名单，未知值直接拒绝）、`size`（提供时覆盖 `width`/`height`）、`width`、`height`、`use_opencl`、`show_diffusion_process`、`show_diffusion_stride`、`image`、`mask`（必须与 `image` 同时给出）、`denoise_strength`、`aspect_ratio`。
工具级参数：`outputPath`、`model`（与当前服务模型不一致时先经控制平面切换）、`transport`、`host`、`serial`。

行为：建立连接 → `POST /generate` → 增量消费 SSE（静默超时按块判定）→ `{"type":"error"}` 立即抛出服务端消息 → `complete` 时校验 `channels === 3` 且 `bytes.length === width*height*channels`，编码 PNG 写入 `outputPath` 或 `<outputDir>/<UTC yyyymmdd-HHMMSS>_<seed>.png`（目录递归创建）。

返回：`{ transport, host, serial, model, path, bytes, seed, width, height, channels, generationTimeMs, firstStepTimeMs, progressEvents, elapsedMs, warnings }`。

### `local_dream_device`（连接与设备生命周期）

`action`：

| action | 说明 |
| --- | --- |
| `status` | adb 路径/版本/命中的解析层级、当前 transport 与 baseUrl、控制平面地址、本插件创建的 forward、`adb devices -l` 解析结果、缓存主机、最后一次失败原因 |
| `discover` | 主动发现：先探 8808 `/info` 指纹，再探 8081 `/health`；返回候选与来源（`configured` / `cache` / `usb-derived` / `subnet-sweep`），控制平面优先排序 |
| `connect` | 强制建立连接，可覆盖 `transport` / `host` / `serial` |
| `disconnect` | 只移除本插件创建的 adb forward 并清空缓存主机；**绝不触碰 adb server 与其他 forward** |
| `devices` | `adb devices -l` 解析结果 |
| `models` | 8808 `/models`：仅手机已下载的模型（含 `generation_size`、`dit_kind`、upscaler 列表） |
| `select` | `model_id` + `width`/`height` → `POST /select` 并轮询到 `running`（要求 model+分辨率完全匹配） |
| `stop` | `model_id`（可省略）→ `POST /stop`；服务端返回 `ignored: true` 时**如实报告**，不当成功 |

## 传输策略

1. **LAN（首选）**：候选顺序 = `config.host` → 进程内缓存的 last-known-good 主机 → 自动发现。逐个用控制平面 `/info`（`app === "localdream"`）或生成端 `/health` + `/tokenize` 指纹确认。
2. **USB（回退）**：解析 adb → `adb devices -l` → 选设备 → `adb forward tcp:<localPort> tcp:8081`（同时为控制平面建 `tcp:<localPort2> tcp:8808`）→ 在 `127.0.0.1` 上跑同一套探活/激活流程。
3. **都不可用**：按 `pollIntervalMs` 交替轮询 `adb devices` 与 LAN 探活，直到 `waitTimeoutMs` 用尽；超时抛出**包含每一次尝试与失败原因**的结构化错误。

设备选择：只保留状态恰为 `device` 的条目；恰好一个才自动使用；零个继续等待；**多于一个绝不猜测**，抛错并列出 `serial` 与 `-l` 属性，提示设置 `serial`。

**LAN 自动发现**（按成本递增）：(a) adb 可用且有设备时，用 `adb -s <serial> shell ip -f inet addr show wlan0` 读手机 Wi-Fi IPv4（任何错误都静默跳过）；(b) 并发 TCP 扫描本地非回环 IPv4 网段（默认每网卡 /24，`maxHosts` 封顶 1024，`concurrency` 并发，`connectTimeoutMs` 单次超时），并通过 `/info` 或 `/health` 指纹二次确认。

**adb 解析层级**（第一个通过 `adb version` 校验的胜出）：`config.adbPath` → `<ANDROID_HOME|ANDROID_SDK_ROOT>/platform-tools/adb[.exe]` → `PATH`（自实现查找，Windows 先试 `.exe`） → `<packageRoot>/vendor/platform-tools/<win32-x64|linux-x64|darwin>/adb[.exe]`（POSIX 先 `chmod 0o755`）。`<packageRoot>` 由 `import.meta.url` 推导，因此源码直载（`src/index.ts`）与 `node_modules` 安装两种形态都可用。

## 两种局域网模式

Local Dream 有两条完全不同的局域网路径，插件两者都支持：

| | 普通「允许局域网访问」 | Device Link「主机模式」 |
| --- | --- | --- |
| 端口 | 只有 8081 | **8808 控制平面** + 8081 生成后端 |
| 谁能启动后端 | 用户必须在 App 里手动加载模型 | 插件可 `POST /select` 启动 |
| 8081 未监听时 | 后端没起来 | **正常状态**，`/select` 之后才会监听 |
| 身份指纹 | `/tokenize` 返回 `max_length === 77` | `/info` 返回 `app === "localdream"` |
| 插件行为 | 直接探活 → 出图 | `/info` → `/status` → 必要时 `/select` → 轮询到 `running` → `/health` |

> 首次使用主机模式需要**在 App 里手动进入一次**（下拉菜单里的 "Device Link / 设备互联"）；进入后 8808 立刻开始监听，后端处于 standby，由插件负责 `/select` 激活。

**普通局域网模式的开启方式**：在手机上打开 Local Dream → 进入设置（齿轮）→ 打开 **「允许局域网访问」/ "Allow LAN access"** 开关 → 回到主界面**手动加载一次模型**，此时后端才会在 `0.0.0.0:8081` 上监听。之后插件即可通过 `config.host`（或自动发现）直连；此时没有 8808，模型切换必须由用户在 App 内完成（`autoSelect` 对该模式无效，此时 `local_dream_device` 的 `models`/`select`/`stop` 动作都会报"控制端口不可达"）。

控制平面路由（全部 JSON，**无任何鉴权**，与 App 的"允许局域网访问"信任模型一致）：

| 路由 | 说明 |
| --- | --- |
| `GET /info` | `{"app":"localdream","protocol":1,"version":"3.0.0-alpha.4","device":"V2463A"}` —— 精确身份指纹 |
| `GET /models` | `{"use_img2img":bool,"models":[{id,name,generation_size,is_sdxl,dit_kind,...}],"upscalers":[...]}`，只含**已下载**的模型 |
| `POST /select` | `{"model_id":"<id>","width":512,"height":512}`（宽高省略即 512）；`200 {"ok":true}`、`404 model not found`、`400 DiT resolution must be 512..2048 in 24-pixel steps`、`500 backend start rejected`；伪 id `__upscaler__` = 独立放大模式。返回即"已请求启动"，模型随后加载 |
| `GET /status` | `{"serving_model_id":...,"state":"idle|starting|running|error","message":...,"error_model_id":...,"width":...,"height":...}`；插件要求 **model_id + width + height 完全匹配**才算 ready，绝不把仍在服务旧分辨率的进程当作就绪 |
| `POST /stop` | `{"model_id":"<id>"}`（可省略）；model_id 非当前选择时返回 `{"ok":true,"ignored":true}`，插件如实报告 |

主机模式下 8081 由原生后端在 `--listen_all` 下提供：`/generate`、`/tokenize`、`/health`、`/upscale`（权重路径走 `X-Upscaler-Path` 头）。插件用 `GET /health` 作为生成端的主探活手段，`/tokenize` 指纹作为二次身份确认。

## 开发

```sh
npm install
npm run typecheck          # tsc 类型检查（erasable-syntax-only，兼容 Node 原生 type stripping）
npm test                   # 单元 + 注册测试（无网络、无设备，全部注入假实现）
npm run test:integration   # 真实设备冒烟；没有设备/主机时打印 SKIP 并以 0 退出
```

`test:integration` 环境变量：`LOCAL_DREAM_HOST`、`LOCAL_DREAM_MODE`、`LOCAL_DREAM_DISCOVER=1`、`LOCAL_DREAM_MODEL`、`LOCAL_DREAM_SERIAL`、`LOCAL_DREAM_GENERATE=1`（额外跑一次真实出图）、`LOCAL_DREAM_SIZE`、`LOCAL_DREAM_OUTPUT_DIR`。

## 设计要点

- **不经 shell**：adb 与一切子进程都以参数数组 `spawn`，没有任何引号/转义注入面。
- **错误契约**：失败统一抛 `LocalDreamError`（`code` + 消息；HTTP 场景附 `status`；`connection` 标记可重连，`fatal` 标记重试无意义；等待超时附 `attempts` 全部尝试记录）。
- **连接管理器串行化**：每个插件实例一个 `ConnectionManager`。DSH 可能并发跑几十个工具调用，`ensure()` 走单条 promise 链串行化，所以**不会每个调用各建一个 forward**。
- **取消**：所有工具都尊重 `exec.signal`（`AbortSignal.any` 合并超时；SSE 读取循环逐块检查；等待睡眠可被中断）。
- **图片不进上下文**：SSE 里的 base64 图片默认换成字节数摘要；只有显式 `includeImage: true` 才内联。
- **用 `/health` 而不是 `/tokenize` 做探活**：`/health` 更便宜，`/tokenize` 保留为身份指纹。
- **不杀 adb server**：插件只做 `adb devices`/`forward`/`shell`，**从不执行 `adb kill-server`**，也不删除别人的 forward；`disconnect` 只清理自己创建的那几条。
- **主机模式下 8081 关闭是正常态**：不会当作错误，而是驱动 `/select` 让后端起来。

## 安全与副作用披露

- 本插件会**调用 `adb`**（`devices -l`、`forward`、`forward --list`、`forward --remove`、`shell ip -f inet addr show wlan0`）。
- 当 `discovery.enabled` 为 `true`（默认）时，插件会对**本机所有非回环 IPv4 网段**的 `port`（默认 8081）与 `controlPort`（默认 8808）发起 TCP 连接扫描，用于发现手机；用 `discovery.subnets` 可把范围限制到指定 CIDR，或直接 `discovery.enabled: false` 关闭。
- 控制平面（8808）**没有鉴权**，任何能访问该端口的人都能切换模型/停止后端；这正是 Local Dream 主机模式自身的信任模型。请在可信局域网中使用。
- 出图请求的 prompt/图片只在**本机 → 手机**之间传输，插件不会把任何内容发往第三方。

## npm 发布（@xinvxueyuan/cordis-plugin-local-dream）

- **仓库**: https://github.com/xinvxueyuan/cordis-plugin-local-dream
- **npm**: `npm install @xinvxueyuan/cordis-plugin-local-dream`
- **许可**: MIT OR Apache-2.0（见 LICENSE-MIT / LICENSE-APACHE）

### 发布流程（维护者）— staged publishing

> 采用 npm **staged publishing**：CI 用 `npm stage publish`（OIDC 可信发布，无需 token / 2FA）
> 把版本放入 registry 的 **stage 队列**，维护者用 **2FA** 批准后版本才真正上线（proof-of-presence）。

```sh
# 1) 构建 + 本地核对
npm run build
npm pack --dry-run

# 2) 打标签推送 → GitHub Actions 自动跑测试 + npm stage publish（进入 stage 队列）
git tag v0.1.x && git push origin main --tags

# 3) 人工 2FA 批准上线
npm stage list @xinvxueyuan/cordis-plugin-local-dream   # 取 <stage-id>
npm stage approve <stage-id>                            # 需要 2FA
```

（旧版 `npm publish` 直发流程已被 CI 的 staged 流程取代。）
