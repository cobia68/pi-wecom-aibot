import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hostSecrets, imageLink, imageMarkdown, parseImageHosts, redactSecrets, uploadImage, type ImageHost,
} from "../../../src/extension/screen/image-hosts.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const http: ImageHost = { type: "http", url: "https://images.example/upload", fileField: "image", urlPath: "data.url" };

test("image host configuration accepts only generic HTTP hosts", () => {
  assert.deepEqual(parseImageHosts(undefined), []);
  assert.deepEqual(parseImageHosts(null), []);
  assert.deepEqual(parseImageHosts([]), []);
  const hosts: ImageHost[] = [
    http,
    { ...http, url: "https://backup.example/upload", fields: { key: "api-key" }, headers: { Authorization: "Bearer api-token" } },
  ];
  assert.deepEqual(parseImageHosts(hosts), hosts);
  for (const bad of [
    {}, [null], [{ type: "other" }], [{ ...http, url: "http://images.example/upload" }],
    [{ ...http, url: "https://name:password@images.example/upload" }], [{ ...http, url: "https://images.example/upload#secret" }],
    [{ ...http, fileField: "" }], [{ ...http, headers: { Authorization: "a\r\nb" } }],
    [{ ...http, urlPath: "data..url" }], Array(6).fill(http),
  ]) assert.throws(() => parseImageHosts(bad), /imageHosts/);
});

test("retired Gitea entries are rejected, including mixed lists and entries with HTTP fields", () => {
  const retired = { type: "gitea", repo: "https://git.example/owner/images", token: "retired-private-token" };
  for (const hosts of [[retired], [retired, http], [http, retired], [{ ...http, ...retired }]]) {
    assert.throws(() => parseImageHosts(hosts), (error: Error) => {
      assert.match(error.message, /imageHosts 第 [12] 项.*type 只能是 http/);
      assert.doesNotMatch(error.message, /retired-private-token|git\.example/);
      return true;
    });
  }
});

test("a failed HTTP host falls back to the next one; success prevents later uploads", async (t) => {
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    methods.push(`${init?.method} ${new URL(url).hostname}`);
    if (new URL(url).hostname === "failed.example") return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    return Response.json({ data: { url: "https://cdn.example/screen.png" } });
  });
  const result = await uploadImage(png, [
    { ...http, url: "https://failed.example/upload" }, http,
    { ...http, url: "https://unused.example/upload" },
  ]);
  assert.equal(result.url, "https://cdn.example/screen.png");
  assert.equal(result.host, "http images.example");
  assert.deepEqual(methods, ["POST failed.example", "POST images.example"]);
});

test("HTTP uploads use multipart file/fields/headers and accept JSON-path or plain-text links", async (t) => {
  let response: Response;
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL, init: RequestInit) => { calls.push(init); return response; });
  response = Response.json({ data: { url: "https://cdn.example/screen.png" } });
  const result = await uploadImage(png, [{ ...http, fields: { key: "private-key" }, headers: { Authorization: "Bearer token" } }]);
  assert.equal(result.url, "https://cdn.example/screen.png");
  const request = calls[0];
  assert.equal(request.redirect, "error", "a redirect must not replay credentials or screen contents elsewhere");
  assert.equal(new Headers(request.headers).get("authorization"), "Bearer token");
  const form = request.body as FormData;
  assert.equal(form.get("key"), "private-key");
  const file = form.get("image") as File;
  assert.equal(file.name, "pi-screen.png");
  assert.equal(file.type, "image/png");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
  response = new Response("https://cdn.example/plain.png\n");
  assert.equal((await uploadImage(png, [{ ...http, urlPath: undefined }])).url, "https://cdn.example/plain.png");
});

test("ordinary form values can also occur in the public image URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("https://cdn.example/public-screen-folder/image.png"));
  const host: ImageHost = { ...http, urlPath: undefined, fields: { folder: "public-screen-folder", reqtype: "fileupload" } };
  assert.equal((await uploadImage(png, [host])).url, "https://cdn.example/public-screen-folder/image.png");
  assert.equal(hostSecrets([host]).includes("fileupload"), false);
});

test("each upload request has a 30-second deadline and timeouts can fall through to the next host", async (t) => {
  let deadlines = 0;
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 30_000);
    return ++deadlines === 1 ? AbortSignal.abort(new DOMException("timed out", "TimeoutError")) : new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async (_url: string | URL, init: RequestInit) => {
    init.signal!.throwIfAborted();
    return new Response("https://cdn.example/backup.png");
  });
  const plainHost = { ...http, urlPath: undefined };
  const result = await uploadImage(png, [plainHost, { ...plainHost, url: "https://backup.example/upload" }]);
  assert.equal(result.url, "https://cdn.example/backup.png");
  assert.equal(deadlines, 2);
});

test("unsafe links and malformed responses fail with bounded, redacted diagnostics", async (t) => {
  const token = "SENSITIVE-TOKEN-" + "x".repeat(80);
  let response = new Response("prefix ".repeat(20) + token + " suffix", { status: 401 });
  t.mock.method(globalThis, "fetch", async () => response);
  const host: ImageHost = { ...http, headers: { Authorization: `Bearer ${token}` } };
  await assert.rejects(uploadImage(png, [host]), (err: Error) => /HTTP 401/.test(err.message) && !err.message.includes("SENSITIVE") && err.message.length < 300);
  for (const body of ["not JSON", JSON.stringify({ data: { url: "http://cdn.example/insecure.png" } }), JSON.stringify({ data: { url: "https://cdn.example/a.png) injected" } })]) {
    response = new Response(body);
    await assert.rejects(uploadImage(png, [http]), /图片上传失败/);
  }
  assert.equal(imageLink("https://cdn.example/a%20b.png"), "https://cdn.example/a%20b.png");
  for (const link of ["javascript:alert(1)", "http://cdn.example/a.png", "https://user:pass@cdn.example/a.png", "https://cdn.example/a(b).png", "https://cdn.example/a.png\ntext"]) assert.equal(imageLink(link), undefined);
  assert.equal(imageMarkdown("https://cdn.example/a.png"), "![pi 终端画面](https://cdn.example/a.png)");
});

test("credential collection includes query, header and form values and redacts before truncation", () => {
  const secrets = hostSecrets([{ ...http, url: "https://images.example/upload?key=a%2Bb%2Fc", headers: { Authorization: "Bearer header-secret" }, fields: { token: "form-secret" } }]);
  assert.ok(secrets.includes("a+b/c"));
  assert.ok(secrets.includes("header-secret"));
  assert.ok(secrets.includes("form-secret"));
  assert.equal(redactSecrets("a+b/c a%2Bb%2Fc header-secret form-secret", secrets), "**** **** **** ****");
});

test("upload responses are bounded and oversized bodies are cancelled", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(uploadImage(png, [http]), /64 KiB/);
  assert.equal(cancelled, true);
});

test("cancellation stops the active request and never starts the next configured host", async (t) => {
  const abort = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  });
  const pending = uploadImage(png, [http, { ...http, url: "https://next.example/upload" }], { signal: abort.signal });
  abort.abort(new Error("screen cancelled"));
  await assert.rejects(pending, /screen cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(uploadImage(png, [http], { signal: abort.signal }), /screen cancelled/);
  assert.equal(calls, 1);
});
