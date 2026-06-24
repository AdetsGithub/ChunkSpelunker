This spec is exceptionally robust. v1.1.0 resolves the major architectural blockers that usually doom tools in this space. You have successfully designed a pipeline that bridges the gap between dynamic crawling and static AST analysis.

However, moving from design to implementation against *real-world* SPAs will expose a few operational realities. Before writing code, we need to address these five lingering friction points.

## 1. The Memory Bloat Trap (OOM Risks)

**The Issue:** §12.1 defines `PipelineContext` holding `jsAssets` with optional string `body`, capped at 500 files. If an average minified chunk is 2MB, holding 500 of them in a `Map` consumes 1GB of RAM for raw strings alone, before V8’s internal object overhead. Furthermore, §7.6 captures `postData` for all XHR/Fetch calls. If the crawler triggers a file upload or bulk telemetry post, you are caching massive payloads in memory.
**The Fix:**

* **JS Asset Streaming:** Do not store JS bodies in the `PipelineContext` Map. Write them to a temporary directory on disk (`os.tmpdir()`) during interception. Pass file paths to the AST workers, allowing them to stream/read the file independently and let the OS handle file caching.
* **Payload Caps:** Introduce a hard cap for network request body capture (e.g., truncate `postData` and `response.body` at `256KB`). You only need the shape of the JSON to infer parameter names, not the whole payload.

## 2. The Modal Overlay & Z-Index Trap

**The Issue:** §7.4 specifies clicking elements up to 40 times per page. Playwright's default `element.click()` enforces actionability checks (visible, enabled, not obscured). If click #3 triggers a modal (e.g., a "Confirm Settings" dialog), it will drop a backdrop over the page. Clicks #4 through #40 will immediately fail because the elements are now obscured by the modal backdrop.
**The Fix:**

* Add `{ force: true }` to the crawler's click options to bypass Playwright's actionability checks, directly firing the event on the DOM node.
* *Alternatively*, implement a "DOM reset" mechanism: press the `Escape` key between clicks, or use a broad DOM-mutator observer to detect injected modals and blindly click the "close" button before resuming the main loop. (I recommend `{ force: true }` for v1, as it’s significantly cheaper to implement).

## 3. Path Template Precedence (AST vs Network)

**The Issue:** §10.3 handles parameterization, and §10.2 dictates that merged endpoints "prefer network for method certainty; union param names." But what happens to the *path template*?

* Network infers: `/api/v1/users/{id}/profile`
* AST extracts: `/api/v1/users/{{userId}}/profile`
If they merge, which path string wins?
**The Fix:**
* Explicitly specify that **AST path templates take precedence over network-inferred templates**. The AST contains the developer's semantic variable name (`userId`), whereas the network parameterizer can only ever guess generic names (`id`, `uuid`).

## 4. Babel's Call Stack Vulnerability

**The Issue:** §9.0 isolates AST work to avoid blocking the event loop. However, Babel parsing massive, deeply nested minified Webpack bundles frequently throws `RangeError: Maximum call stack size exceeded` at the V8 engine level, overriding Babel's `errorRecovery: true`.
**The Fix:**

* In the `ast-worker.js`, wrap the `babel.parse` call in a broad `try/catch` that specifically catches `RangeError` (stack overflows) in addition to `SyntaxError`. When caught, immediately degrade that specific file to the regex fallback engine and return the regex findings via IPC.

## 5. Relative Path Context Loss

**The Issue:** §9.4 states relative paths resolve against "current page URL or JS asset URL". But static analysis of an isolated JS chunk doesn't inherently know which page triggered it. If `chunk.123.js` contains `fetch('./data')`:

* Loaded on `/dashboard/reports` -> it resolves to `/dashboard/reports/data`
* Loaded on `/dashboard/settings` -> it resolves to `/dashboard/settings/data`
**The Fix:**
* The `NetworkStore` must maintain a mapping of `jsAssetUrl -> Set<pageUrls>`. When the AST worker yields a relative URL, the Merger must generate an endpoint permutation for *each* known page context that loaded that chunk.

