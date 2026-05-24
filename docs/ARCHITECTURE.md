# Mithic: Core Architecture & Technical Design Document

**System Version:** 2026.1

**Core Components:** Isomorphic Virtual Shell + Universal Mount VFS (`VFS`) + WASI Preview 2 Runtime (`jco` / Native Worker Bridges).

---

## 1. Executive & Architectural Vision

Mithic is designed to provide a secure, foundational isomorphic execution environment that functions identically across local web, desktop, and cloud environments. It bridges the gap between power-user terminal workflows and modern, interactive UI-driven applications.

### Core Pillars

- **Isomorphic Execution**: Code runs in the browser via `jco` (WebAssembly Component Model) and on native systems using compatible WASM runtimes, ensuring portability.
- **Everything is a File**: Instead of implementing point-to-point abstractions for separate integrations, Mithic generalizes the VFS into an unified provider interface. Cloud integration (S3, Google Drive), browser primitives (`/dev/clipboard`, `/dev/gpu`), decoupled frontend presentation layers (`/dev/gui`) can all be implemented symmetrically as pluggable system mounts. 
- **Agentic Foundations**: The system is built for any running process (WASM binary, bash script, or AI agent) to interact with resources through the virtual shell, utilizing standardized CLI tools (`cat`, `ls`, `cp`, `grep`, `mkdir`) and filesystem paths rather than custom APIs, without awareness of the underlying physical, cloud, or synthetic transport medium.

---

## 2. Universal Pluggable Virtual File System (`VFS`)

The backbone of Mithic is a highly extensible, reactive VFS router that handles absolute file paths by delegating read, write, watch, and stat events to decoupled, targeted drivers.

```
                          [ VFS Core Router ]
                                     |
    +-----------------+--------------+---------------+-------------------+
    |                 |                              |                   |
[/home /etc]     [/mnt/cloud]                    [/dev]               [/shared]
    |                 |                              |                   |
 [Local Storage]  [Isomorphic Cloud Bridge]     [Synthetic IPC Engine] [P2P CRDT Sync]
    |                 |                              |                   |
(IndexedDB/OPFS) (S3 API / REST Web Proxies)  (React MessagePorts)   (Automerge/libp2p)

```

### 2.1 Driver Mount Architecture

VFS implements a simple, uniform interface definition block across both Web Workers and native runtime implementations. Custom mount providers must implement the following lifecycle hooks:

```typescript
interface VFSMountProvider {
  mountPoint: string;
  init(): Promise<void>;
  read(path: string, options?: ReadOptions): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  watch(path: string, callback: (event: VFSChangeEvent) => void): UnsubscribeFunc;
}

```

### 2.2 Standard Mount Registry Layout

* **`/home` and `/etc` (Local Client Persistence):** Backed by high-performance storage blocks inside the host runtime環境. In browsers, this leverages the **Origin Private File System (OPFS)** or indexed database engines (`BrowserFS`), assuring sub-millisecond, zero-network write speeds and robust data boundaries.
* **`/mnt/cloud/*` (The Isomorphic Cloud Bridge):** Provides standard native filesystem access to remote resources.
* `/mnt/s3/backups`: Intercepts calls and streams multi-part file chunks on-demand via authenticated S3 REST API protocols.
* `/mnt/http/api`: Translates file write actions into outgoing web-hook payloads or REST requests, and directory listing commands into API schema queries.


* **`/dev/*` (Synthetic Device Abstraction Layer):** Bridges the sandboxed runtime directly to Host features and UI constructs through safe, virtual target descriptors.
* `/dev/gui` & `/dev/ui`: Acts as the rendering highway. When a sandboxed utility writes a serialized `remote-dom` configuration layout into `/dev/gui`, the host UI thread captures the event, parses the declarative JSON layout, and surfaces interactive UI components seamlessly. Blocked reads to `/dev/gui` pause execution until user interaction clicks or input events flush state back downstream.
* `/dev/clipboard`: Forwards Unix pipelines directly into host operating system clipboards via basic CLI commands (`echo "data" > /dev/clipboard`).
* `/dev/gpu`: Allocates direct parallel computing hardware tasks by translating binary filesystem reads/writes into browser **WebGPU** contexts.


* **`/shared/*` (P2P Synchronization / Multi-user Collaborative Layer):** Encapsulates the entire collaborative engine. Directory hierarchies mounted here automatically pass underlying file metadata structural mutations through an **Automerge CRDT** object to avoid tree conflicts across peers. Large raw binary blobs are mapped via an IPFS content-addressed hash layer, streaming file chunks peer-to-peer via **libp2p WebRTC** paths strictly when requested.

---

## 3. The Virtual Shell notebook Framework (`just-bash`)

Mithic exposes this universal filesystem interface via an interactive terminal cell workspace environment leveraging the lightweight `just-bash` scripting core.

### 3.1 Dynamic Command Fallback Pattern

To enable decoupled execution of dynamic application components, Mithic explicitly avoids manually mapping hardcoded platform script calls. Instead, `just-bash` implements a customized Abstract Syntax Tree (AST) **Transform Plugin**:

1. **Command Interception:** When a script, user, or AI agent types an unregistered command name expression (e.g., `shrink-video --input raw.mp4`), the shell checks its internal aliases. If the binary command is completely absent, execution triggers an immediate fallback hook.
2. **AST Transformation plugin:** The AST engine dynamically rewrites the parsed input script into a system command wrapper call targeting the core execution driver:
```bash
# Original Input:
shrink-video --input raw.mp4

# Transformed Execution Path:
exec /bin/shrink-video.wasm --input raw.mp4

```


3. **VFS Path Resolution:** The fallback logic checks `/bin` or path environment parameters within VFS to locate the targeted `.wasm` component artifact, and boots it instantly.

### 3.2 VFS as a Reactive Signal Engine

Because VFS handles all storage and device operations natively, the shell notebook replaces standard heavyweight background process communication buses with file watchers. Cells subscribe to targeted VFS path scopes.

For example, when a DuckDB/SQLite WASM process flushes raw processed output into `/home/data/results.csv`, VFS fires a change event that signals the front-end display frontend to refresh data components instantly—providing automated persistence, complete inspection, and strict state reliability.

---

## 4. Multi-Process Execution Engine (WASM Sandboxing)

Mithic preserves full host security and environment portability using sandboxed WebAssembly execution pipelines.

```
+------------------------------------------------------------+
|                       Host Runtime                         |
|   (React MFE UI Thread / Node.js Native Desktop Process)    |
+------------------------------------------------------------+
       ^                                              ^
       | [SharedArrayBuffer / MessagePorts]            | [WASI P2 Filesystem Shim]
       v                                              v
+-----------------------------+        +-----------------------------+
|     WASM Execution Worker   |        |     WASM Execution Worker   |
|   [Process ID 102: ffmpeg]  |        |    [Process ID 103: pandoc] |
+-----------------------------+        +-----------------------------+

```

### 4.1 Process Table Isolation

Each executable utility is launched as an isolated multi-threaded system worker lifecycle block. The core host maintains a centralized `Process Table` tracking:

* Active Process IDs (PIDs).
* Scoped mount maps (e.g., giving a tool access strictly to `/home/user/sandbox` and `/dev/gui`).
* Standard I/O pointers (`stdin`, `stdout`, `stderr`) piped cleanly across processing lines.

### 4.2 Isomorphic Runtime Bridge

Mithic bridges the gap between different host architectures using identical software abstractions:

* **Web Context:** Sandboxed workers run target `.wasm` binaries using bytecode generated via the **`jco`** (WebAssembly Component Model) compiler infrastructure.
* **Native Context:** To maintain total environment parity without sacrificing raw execution speed, native desktop frameworks (built on Electron or Tauri) invoke identical Node.js worker blocks running the same component targets, or spawn highly secure sandboxed rust native execution processes (like `wasmtime`).

### 4.3 Low-Latency System Shims (`SharedArrayBuffer`)

To handle raw data throughput boundaries when passing massive binary files (like raw video frames or hefty databases) from VFS to the sandboxed runtime, execution threads bypass standard asynchronous `postMessage` loops.

Instead, a low-level **WASI Preview 2 Filesystem Shim** opens synchronous memory tunnels over **`SharedArrayBuffer`** references. When a sandboxed utility executes standard file read operations, the worker blocks thread loop execution using atomic operations (`Atomics.wait`), reading direct storage data instantly out of shared physical memory addresses.

---

## 5. Security Architecture & Permission Framework

Because VFS handles *all* input/output vectors identically, Mithic establishes an absolute sandbox defense layer with simple path-permission scoping rule checks.

1. **Zero-Trust by Default:** By default, a freshly spawned process possesses zero host visibility, zero network socket loops, and can neither read nor write to any VFS mount path.
2. **Declarative Manifest Routing:** Every application or script configuration declares its required file system dependency boundaries explicitly:
```json
{
  "lab": "ffmpeg-compressor",
  "permissions": {
    "read": ["/home/user/videos", "/dev/gpu"],
    "write": ["/home/user/videos/compressed", "/dev/gui"]
  }
}

```


3. **Host Authorization Prompts:** VFS intercepts mount read/write requests at the router level. If an application attempts to write outside authorized parameters, the host runtime intercepts execution and triggers a security approval layout context to the user: *“Allow this tool to write to /home/user/videos? [Grant / Deny]”*.

---

## 6. Engineering Implementation Roadmap

### Phase 1: Core Router Foundation

* Implement the core reactive `VFS` router block.
* Establish structural code configurations for standard local persistence storage drivers (`OPFS` / `IndexedDB`).
* Integrate the dynamic AST transform plugin inside the `just-bash` interpreter loop.

### Phase 2: Synthetic Devices & Cloud Mounting

* Build the synthetic IPC driver layer supporting `/dev/gui`, `/dev/clipboard`, and `/dev/gpu` pipelines.
* Create the Isomorphic Cloud Bridge module to map remote S3 backends into standard file hierarchies.

### Phase 3: Multi-Process Execution & Security Shims

* Build the `jco` Web Worker execution framework managing isolated Process Tables.
* Optimize system read/write overhead by completing the low-latency `SharedArrayBuffer` WASI P2 filesystem shim.
* Enforce path-scoped authorization rules and user prompt callbacks across all active mounts.

### Phase 4: Collaborative Layer Integration

* Mount the collaborative network system driver into `/shared/*` using `libp2p` transport wrappers and `Automerge` conflict trees.