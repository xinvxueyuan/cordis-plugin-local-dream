# cordis-plugin-local-dream

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-local-dream)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-local-dream)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-local-dream)](https://github.com/xinvxueyuan/cordis-plugin-local-dream)

> Cordis（DeepSeek Harness）插件：让 agent 直接驱动 Android 应用 **Local Dream**（内置 HTTP 后端的 Stable Diffusion 应用）出图。

**默认走局域网直连（LAN）；局域网不可用时自动回退 USB（adb forward）；两者都不可用时按 `waitTimeoutMs` 轮询等待。**
在 "设备互联 / 主机模式" 下，插件还会自己驱动 8808 控制平面（`POST /select` 启动 8081 生成后端），因此"手机在跑但后端没起来"这种正常状态不会变成报错。

- 三个工具：`local_dream_api`（通用端点直通）、`local_dream_generate`（高层出图，直接落盘 PNG）、`local_dream_device`（连接与设备生命周期）。
- 只依赖 Node 内置能力（全局 `fetch`、`node:zlib`、`node:net`、`node:child_process`），**零运行时依赖**。
- SSE 增量解析 + 原始 RGB 像素校验 + 自研 PNG 编码器；图片字节不会进入模型上下文。

## 安全不变量与副作用披露

- 本插件会**调用 `adb`**（`devices -l`、`forward`、`forward --list`、`forward --remove`、`shell ip -f inet addr show wlan0`）。
- 当 `discovery.enabled` 为 `true`（默认）时，插件会对**本机所有非回环 IPv4 网段**的 `port`（默认 8081）与 `controlPort`（默认 8808）发起 TCP 连接扫描，用于发现手机；用 `discovery.subnets` 可把范围限制到指定 CIDR，或直接 `discovery.enabled: false` 关闭。
- 控制平面（8808）**没有鉴权**，任何能访问该端口的人都能切换模型/停止后端；这正是 Local Dream 主机模式自身的信任模型。请在可信局域网中使用。
- 出图请求的 prompt/图片只在**本机 → 手机**之间传输，插件不会把任何内容发往第三方。

本插件**不**执行 `adb kill-server`，也不删除别人的 forward（见「设计要点」）。它唯一的本地写入是出图结果 PNG 落到 `outputDir`。

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
| `controlPort` | `8808` | 手机端 Device Link 控制平面端口；`0` = 关闭控制平面；主机模式本身即强制 LAN 绑定，**不需要**打开「允许局域网访问」 |
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

Local Dream 有两条通往 LAN 的路径，但**两条路径最终汇合到同一个布尔与同一个 `--listen_all`，因此绑定行为完全一致**：任意一条成立，原生后端就绑定 `0.0.0.0:8081`。**主机模式（受控端）即使关闭「允许局域网访问」也会向 LAN 开放 —— 这是 `||` 的预期行为，不是缺陷。**

因果链（每一跳都可在上游 `xororz/local-dream`（分支 `master`）里按 `file:line` 复核）：

```text
[开关] ModelListScreen.kt:1791-1798
  preferences.edit { putBoolean("listen_on_all_addresses", it) }
        |
        |   [主机模式] RemoteHostService.kt:86   updateState(running = true)
        |             RemoteHostService.kt:112  updateState(running = false)  (onDestroy)
        |             -> 暴露为 RemoteHostService.isRunning（内存态 MutableStateFlow）
        v                      v
        +----------+-----------+
                   |
                   v
  BackendService.kt:231-234
  val listenOnAll = getSharedPreferences("app_prefs", MODE_PRIVATE)
      .getBoolean("listen_on_all_addresses", false) ||
      RemoteHostService.isRunning.value        <- 布尔 OR：任一为真即 LAN
                   |
                   v
  BackendService.kt:588
  if (listenOnAll) {
      command += "--listen_all"                <- 全仓库唯一追加该 flag 的地方
  }
                   |
                   v
  app/src/main/cpp/src/main.cpp : --listen_all
  "Listen on 0.0.0.0 instead of 127.0.0.1"
                   |
                   v
  0.0.0.0:8081（生成 API）
```

`BackendService.kt:231-234` 上方的注释还指出：bind address 需求变化会命中 config 相等性检查，从而**重启**后端以重新绑定 —— 所以刚进入主机模式的那一刻，8081 不一定马上可达。

| | 普通「允许局域网访问」 | Device Link「主机模式」 |
| --- | --- | --- |
| 绑定行为 | 开关打开时 `0.0.0.0:8081` | **完全相同**：`||` 合并后走同一个 `--listen_all` → `0.0.0.0:8081` |
| 端口 | 只有 8081 | **8808 控制平面** + 8081 生成后端 |
| 唯一的能力差异 | 没有控制平面 | **8808 控制平面**：列模型 / 远程 `select` 启动后端 / `stop` |
| 谁能启动后端 | 用户必须在 App 里手动加载模型 | 插件可 `POST /select` 启动 |
| 8081 未监听时 | 后端没起来 | **正常状态**，`/select` 之后才会监听 |
| 身份指纹 | `/tokenize` 返回 `max_length === 77` | `/info` 返回 `app === "localdream"` |
| 生命周期 | 持久偏好（写进 `app_prefs`），重启 App 仍在，不需要任何服务 | 运行时状态（内存态 `StateFlow`），只活在服务存活期间 |
| 服务退出时 | — | 主动关停：`RemoteHostService.kt:112` 的 `onDestroy` 关掉 8808 控制服务，并发送 `BackendService.ACTION_STOP` 把 8081 后端一并停掉 |
| 与开关的关系 | — | **强制 LAN 打开**，与偏好开关的取值无关 |

> 首次使用主机模式需要**在 App 里手动进入一次**（下拉菜单里的 "Device Link / 设备互联"）；进入后 8808 立刻开始监听，后端处于 standby，由插件负责 `/select` 激活。

**插件如何选择**：本插件把两者当作不同的 LAN 模式，原因只有一个 —— 只有主机模式提供插件自动 `/select` 所需的 **8808 控制平面**；只打开「允许局域网访问」时，后端必须**已经由人在 App 内启动并加载好模型**，因此 `autoSelect` 在该路径上没有任何作用（`models`/`select`/`stop` 会报"控制端口不可达"）。这也是探活顺序的由来：**先探 8808 `/info` 指纹（`app === "localdream"`，最强信号），再探 8081 `/health`。**

**例外（独立放大界面）**：standalone 放大界面有自己的启动路径，**完全不看主机模式** —— `UpscaleScreen.kt:191` 只读偏好开关，并据此给自己的进程追加 `--listen_all`。所以在"主机模式开、偏好关"时，那个独立放大进程仍是 localhost-only；经由 `BackendService` 启动的放大才会带上 `--listen_all`。

> **上游注释已过时（勿照抄）**：`RemoteHostService.kt:43` 的 KDoc 声称该服务「flips the `[KEY_HOST_MODE_ACTIVE]` preference so BackendService starts the native backend with `--listen_all`」。全仓库检索显示 `KEY_HOST_MODE_ACTIVE` **只存在于这条文档注释里**：没有任何声明、读取或写入。真实机制是上面那条内存态 `MutableStateFlow`（`RemoteHostService.isRunning`）。

**普通局域网模式的开启方式**：在手机上打开 Local Dream → 进入设置（齿轮）→ 打开 **「允许局域网访问」/ "Allow LAN access"** 开关 → 回到主界面**手动加载一次模型**，后端即在该路径所要求的 `0.0.0.0:8081` 上监听（主机模式不需要这个开关，见上）。之后插件即可通过 `config.host`（或自动发现）直连；此时没有 8808，模型切换必须由用户在 App 内完成。

控制平面路由（全部 JSON，**无任何鉴权**，与 App 的"允许局域网访问"信任模型一致）：

| 路由 | 说明 |
| --- | --- |
| `GET /info` | `{"app":"localdream","protocol":1,"version":"3.0.0-alpha.4","device":"V2463A"}` —— 精确身份指纹 |
| `GET /models` | `{"use_img2img":bool,"models":[{id,name,generation_size,is_sdxl,dit_kind,...}],"upscalers":[...]}`，只含**已下载**的模型 |
| `POST /select` | `{"model_id":"<id>","width":512,"height":512}`（宽高省略即 512）；`200 {"ok":true}`、`404 model not found`、`400 DiT resolution must be 512..2048 in 24-pixel steps`、`500 backend start rejected`；伪 id `__upscaler__` = 独立放大模式。返回即"已请求启动"，模型随后加载 |
| `GET /status` | `{"serving_model_id":...,"state":"idle|starting|running|error","message":...,"error_model_id":...,"width":...,"height":...}`；插件要求 **model_id + width + height 完全匹配**才算 ready，绝不把仍在服务旧分辨率的进程当作就绪 |
| `POST /stop` | `{"model_id":"<id>"}`（可省略）；model_id 非当前选择时返回 `{"ok":true,"ignored":true}`，插件如实报告 |

8081 由原生后端在 `--listen_all` 下提供（**上面两条路径都会走到这里，不是主机模式专属**）：`/generate`、`/tokenize`、`/health`、`/upscale`（权重路径走 `X-Upscaler-Path` 头）。插件用 `GET /health` 作为生成端的主探活手段，`/tokenize` 指纹作为二次身份确认。

## 边界与已知限制

- **只驱动 Local Dream 这一个 App**：身份靠指纹确认（控制平面 `/info` 的 `app === "localdream"`，或生成端 `/tokenize` 的 `max_length === 77`），其它服务不会被误当成后端。
- **必须有一条可用的传输路径**：要么手机与主机在可达的局域网内，要么本机有可用的 `adb`（`config.adbPath` → `ANDROID_HOME`/`ANDROID_SDK_ROOT` → `PATH` → 内置 `vendor/platform-tools`，见「adb 解析层级」）。两条都不通时最终以 `waitTimeoutMs` 超时收尾。
- **多设备绝不猜测**：`adb devices -l` 里状态为 `device` 的条目多于一个时直接抛错，必须显式配置 `serial`。
- **不能替你下载模型**：`models` 只列出手机**已下载**的模型；插件不会下载或安装权重。
- **主机模式需要人工首次进入**：8808 控制平面只在 App 里手动进入过 "Device Link / 设备互联" 后才存在；纯「允许局域网访问」路径下 `autoSelect` 不起作用。
- **控制平面无鉴权**：8808 上的任何客户端都能切模型/停后端（这是 App 自身的信任模型）；请只在可信局域网中使用，或用 `controlPort: 0` 关闭它。
- **自动发现可能漏掉主机**：默认只扫每个网卡的 /24，且受 `discovery.maxHosts`（默认 1024）与 `connectTimeoutMs` 限制；跨网段/大网段主机需要显式配置 `host` 或 `discovery.subnets`。
- **图片只走 RGB**：`complete` 时强制校验 `channels === 3` 且 `bytes.length === width*height*channels`，非 3 通道的返回会被判为异常而拒绝编码。
- **`port` 覆盖仅 LAN 有效**：USB 转发的端口由 `localPort` 决定，单次调用的 `port` 覆盖在 USB 传输下不生效。
- **`requestTimeoutMs` 是静默预算**：它衡量的是 SSE **两次数据之间的间隔**，不是整次请求的总时长上限；正常出图慢但持续有进度就不会被判超时。
- **集成冒烟需要真机**：`npm run test:integration` 在无设备/无主机时打印 SKIP 并以 0 退出，因此 CI 里跑不出真实出图链路。

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

`publish.yml` 在两个发布 job 前都有幂等守卫：先用 `npm view "<包名>@<package.json 的 version>" version`
判断该版本是否已存在于目标 registry，已存在就跳过发布（并在 Step Summary 写明"该版本已存在，跳过发布"），
因此对已发布版本重推 tag 不会产生必然失败的公开红叉。其它检查错误（网络、鉴权、registry 故障）仍会让 job 失败。

### GitHub Release 与签名

> **现状（务必如实理解）**：以下机制描述的是**已经写进本仓库、但尚未实际执行过**的流程。
> 截至写下这段文字，本仓库**还没有产生过任何 GitHub Release**（远端目前也没有任何 tag），所以下面没有任何"已发布"的既成事实。

| 环节 | 将采用的机制 |
| --- | --- |
| tag | **annotated 且 GPG 签名**的 tag（`git tag -s`），GitHub 上会显示 **Verified** 徽标。tag 由维护者在本机用私钥创建并推送，**私钥永不进入 CI**。 |
| Release 附件 | `.github/workflows/release.yml` 在 tag 推送（或手动 `workflow_dispatch` 指定 tag）时执行 `npm pack`，把产出的 `*.tgz` 与 `SHA256SUMS` 上传为 Release 附件。Release 标题即 tag，正文由 `gh release create --generate-notes` 依据 commit 列表自动生成。 |
| 校验和 | `SHA256SUMS` 记录该 tgz 的 sha256（工作流内以 `sha256sum -c` 自校验）。 |
| 校验和的分离签名 | 维护者在本机用**私钥**对 `SHA256SUMS` 生成分离签名 `SHA256SUMS.asc`（`gpg --armor --detach-sign SHA256SUMS`），再手工把 `.asc` 附到 Release 上。**这一步目前没有自动化**，私钥也不进 CI；校验方用 `gpg --verify` 验签。 |
| 构建来源证明 | `release.yml` 调用 `actions/attest-build-provenance`（pin 到 commit SHA），为 **tgz 与 SHA256SUMS 两者**生成 Sigstore 签名的 SLSA 构建来源证明，可用 `gh attestation verify` 校验。 |
| npm 侧 | `release.yml` **完全不执行任何 npm publish**；npm 发布只由上面的 `publish.yml` staged publishing 负责。 |

维护者操作顺序（**尚未执行过**）：

```sh
# 1) 本机确认工作区干净、package.json 的 version 已就位（版本号由发布者手工提升）
git status --porcelain

# 2) 创建 annotated + GPG 签名 tag（私钥仅在本机使用；本机需能完成 GPG 签名）
git tag -s v0.1.1 -m "v0.1.1"

# 3) 只推 tag —— release.yml 会构建产物、生成来源证明并创建 Release
git push origin v0.1.1
```

校验方式：

```sh
# 校验附件未被篡改
sha256sum -c SHA256SUMS

# 校验分离签名（需要维护者的公钥）
gpg --verify SHA256SUMS.asc SHA256SUMS

# 校验构建来源证明（需要 gh CLI）
gh attestation verify xinvxueyuan-cordis-plugin-local-dream-0.1.1.tgz --repo xinvxueyuan/cordis-plugin-local-dream
gh attestation verify SHA256SUMS --repo xinvxueyuan/cordis-plugin-local-dream
```

补充说明：

- `release.yml` 使用 `gh release create --verify-tag`，**要求 tag 已存在、不会自行创建 tag**；重复运行会转为"覆盖上传附件"。
- 所有 workflow 的 `uses:` 都 pin 到完整 40 位 commit SHA（当前：`actions/checkout` v4.4.0、`actions/setup-node` v4.4.0、`actions/attest-build-provenance` v4.2.2），由 `.github/dependabot.yml` 的 `github-actions` 生态负责推进。

## 许可

本仓库采用 **MIT OR Apache-2.0** 双许可（与 `package.json` 的 `license` 字段一致），
许可证原文见 [LICENSE-MIT](LICENSE-MIT) 与 [LICENSE-APACHE](LICENSE-APACHE)。
