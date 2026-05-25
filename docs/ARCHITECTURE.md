# Mithic: Core Architecture & Technical Design Document

**System Version:** 2026.2

**Core Components:** Isomorphic Virtual Shell + Universal Mount VFS + WASI Preview 2 Runtime (`jco` / Native Worker Bridges).

---

## 1. Executive & Architectural Vision

Mithic is designed to provide a secure, foundational isomorphic execution environment that functions identically across local web, desktop, and cloud environments. It bridges the gap between power-user terminal workflows and modern, interactive UI-driven applications.

### Core Pillars

- **Isomorphic Execution**: Code runs in the browser via `jco` (WebAssembly Component Model) and on native systems using compatible WASM runtimes, ensuring portability.
- **Everything is a File**: Instead of implementing point-to-point abstractions for separate integrations, Mithic generalizes the VFS into a unified provider interface. Cloud integration (S3, Google Drive), browser primitives (`/dev/clipboard`, `/dev/gpu`), decoupled frontend presentation layers (`/dev/gui`) can all be implemented symmetrically as pluggable system mounts.
- **Minimal Core, Maximum Composability**: The system provides only foundational I/O primitives (filesystem, HTTP, sockets). Higher-level services (key-value stores, pub/sub messaging, databases) are composed on top of these primitives via standard protocols over virtualized HTTP and socket connections — not through specialized interfaces.
- **Agentic Foundations**: The system is built for any running process (WASM binary, bash script, or AI agent) to interact with resources through the virtual shell, utilizing standardized CLI tools (`cat`, `ls`, `cp`, `grep`, `mkdir`) and filesystem paths rather than custom APIs, without awareness of the underlying physical, cloud, or synthetic transport medium.

---

## 2. Universal Pluggable Virtual File System

The backbone of Mithic is a highly extensible, reactive VFS router that handles absolute file paths by delegating read, write, watch, and stat events to decoupled, targeted drivers.

```
                            [ FileSystemRouter ]
                                     |
    +-----------------+--------------+---------------+-------------------+
    |                 |                              |                   |
[/home /etc]     [/mnt/cloud]                     [/dev]             [/shared]
    |                 |                              |                   |
[Local Storage]  [Isomorphic Cloud Bridge] [Synthetic IPC Engine] [P2P CRDT Sync]
    |                 |                              |                   |
(IndexedDB/OPFS) (S3 API / REST Web Proxies) (React MessagePorts)     (libp2p)

```

### 2.1 FileSystemProvider Interface

VFS implements a simple, uniform async interface across both Web Workers and native runtime implementations:

```typescript
interface FileSystemProvider {
  init?(): Promise<void>;
  dispose?(): Promise<void>;
  open(path: string, flags: OpenFlags): Promise<FileHandle>;
  close(handle: FileHandle): Promise<void>;
  read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array>;
  write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number>;
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  watch?(path: string, callback: (event: WatchEvent) => void): () => void;
}
```

### 2.2 Standard Mount Registry Layout

* **`/home` and `/etc` (Local Client Persistence):** Backed by high-performance storage in the host runtime. In browsers, this leverages the **Origin Private File System (OPFS)** or indexed database engines, assuring sub-millisecond, zero-network write speeds.
* **`/mnt/cloud/*` (The Isomorphic Cloud Bridge):** Provides standard native filesystem access to remote resources.
  * `/mnt/s3/backups`: Intercepts calls and streams multi-part file chunks on-demand via authenticated S3 REST API protocols.
  * `/mnt/http/api`: Translates file write actions into outgoing web-hook payloads or REST requests, and directory listing commands into API schema queries.
* **`/dev/*` (Synthetic Device Abstraction Layer):** Bridges the sandboxed runtime directly to host features through safe, virtual target descriptors.
  * `/dev/gui` & `/dev/ui`: Rendering highway for `remote-dom` declarative UI layouts.
  * `/dev/clipboard`: Forwards Unix pipelines into host operating system clipboards.
  * `/dev/gpu`: Allocates parallel computing tasks via browser **WebGPU** contexts.
* **`/shared/*` (P2P Synchronization / Multi-user Collaborative Layer):** Encapsulates the collaborative engine using **Automerge CRDT** and **libp2p WebRTC** transports.

---

## 3. Networking as a Primitive

Rather than providing specialized high-level service interfaces (key-value stores, pub/sub messaging, RPC), Mithic provides virtualized HTTP and socket primitives. Higher-level services are composed on top:

### 3.1 HTTP Client/Server

```typescript
interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

interface HttpServer {
  listen(handler: IncomingHttpHandler): Promise<void>;
  close(): Promise<void>;
}
```

A key-value store, messaging system, or database client is simply an HTTP or socket client talking to a service endpoint — local, remote, or virtual. This keeps the core minimal while supporting any protocol.

### 3.2 Socket Provider

```typescript
interface SocketProvider {
  createTcpSocket(): Promise<TcpSocket>;
  createUdpSocket(): Promise<UdpSocket>;
  resolveName(name: string): Promise<IpAddress[]>;
}
```

Redis, NATS, PostgreSQL, or any TCP-based service can be accessed through the socket provider without Mithic needing specialized interfaces for each.

---

## 4. The Virtual Shell Framework (`just-bash`)

Mithic exposes the universal filesystem interface via an interactive terminal workspace environment leveraging the `just-bash` scripting core.

### 4.1 Dynamic Command Fallback Pattern

To enable decoupled execution of dynamic application components, `just-bash` implements a customized AST **Transform Plugin**:

1. **Command Interception:** When an unregistered command is typed, the shell checks aliases. If absent, execution triggers a fallback hook.
2. **AST Transformation:** The engine rewrites the input into a system command targeting the execution driver:
```bash
# Original Input:
shrink-video --input raw.mp4

# Transformed Execution Path:
exec /bin/shrink-video.wasm --input raw.mp4
```
3. **VFS Path Resolution:** Checks `/bin` or `PATH` within VFS to locate the `.wasm` component artifact.

### 4.2 VFS as a Reactive Signal Engine

The shell notebook replaces heavyweight background process communication with file watchers. Cells subscribe to targeted VFS path scopes. When a process writes output to a file, VFS fires a change event that signals the frontend to refresh — providing automated persistence and strict state reliability.

---

## 5. Multi-Process Execution Engine (WASM Sandboxing)

Mithic preserves full host security using sandboxed WebAssembly execution pipelines.

```
┌─────────────────────────────────────────────────────────────────┐
│          I/O Loop (main thread or dedicated worker)             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  FileSystemRouter + HttpClient + SocketProvider + Stdio    │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ Atomics.wait / notify
┌──────────────────────────────────────┴──────────────────────────┐
│                   WASM Worker(s) (blocking)                     │
│  ┌─────────────────────┐    ┌─────────────────────┐             │
│  │ Process 101: ffmpeg │    │ Process 102: pandoc │             │
│  └─────────────────────┘    └─────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### 5.1 Process Table Isolation

Each executable is launched as an isolated worker. The host maintains a `Process Table` tracking:

* Active Process IDs (PIDs).
* Scoped mount maps (giving a tool access strictly to allowed VFS paths).
* Standard I/O pointers (`stdin`, `stdout`, `stderr`) piped across processing lines.

### 5.2 Isomorphic Runtime Bridge

* **Web Context:** Workers run `.wasm` binaries via **`jco`** (WebAssembly Component Model).
* **Native Context:** Desktop frameworks (Electron/Tauri) invoke Node.js worker threads or spawn sandboxed native processes (`wasmtime`).

### 5.3 Sync Bridge (`SharedArrayBuffer`)

WASM workers make synchronous WASI calls. The I/O loop processes them asynchronously. The bridge uses `SharedArrayBuffer` + `Atomics.wait/notify` to block the worker until the I/O loop resolves the async operation — enabling synchronous WASI semantics over async providers.

---

## 6. Security Architecture & Permission Framework

VFS handles all I/O vectors uniformly, enabling a simple path-permission sandbox:

1. **Zero-Trust by Default:** A freshly spawned process has zero host visibility, zero network access, and cannot read/write any VFS path.
2. **Declarative Manifest Routing:** Each application declares its filesystem boundaries:
```json
{
  "permissions": {
    "read": ["/home/user/videos", "/dev/gpu"],
    "write": ["/home/user/videos/compressed", "/dev/gui"],
    "network": ["https://api.example.com"]
  }
}
```
3. **Host Authorization Prompts:** VFS intercepts unauthorized access at the router level and triggers user approval prompts.

---

## 7. Package Structure

```
@mithic/io            Stable I/O engine: VFS, HTTP, sockets, sync-bridge
@mithic/wasip2        WASI Preview 2 shim (thin adapter over @mithic/io)
@mithic/process       Process table, spawn/exec, Shell interface
```

---

## 8. Engineering Implementation Roadmap

### Phase 1: Core Router Foundation

* Implement the `FileSystemRouter` with pluggable `FileSystemProvider` mounts.
* Establish local persistence storage drivers (OPFS, MemoryProvider).
* Implement the sync-bridge for WASM worker ↔ I/O loop communication.

### Phase 2: WASI P2 Shim + Virtual Shell

* Implement full WASI Preview 2 interfaces (filesystem, io, cli, http, sockets).
* Integrate `just-bash` as the virtual shell with VFS adapter.
* Build the process table and spawn/exec infrastructure.

### Phase 3: Synthetic Devices & Cloud Mounting

* Build the synthetic device layer (`/dev/gui`, `/dev/clipboard`, `/dev/gpu`).
* Create the cloud bridge module for S3/HTTP-backed filesystem mounts.

### Phase 4: Collaborative Layer

* Mount the P2P sync driver into `/shared/*` using `libp2p`.
