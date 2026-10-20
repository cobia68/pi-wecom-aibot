/**
 * A BridgeClient over an in-process WeComGateway, without IPC: bridge tests run synchronously under
 * mock timers, while the gateway's real routing and WeCom frames (status messages, notifications) are kept.
 * Like a gateway process, the gateway lives only while this client is registered.
 */
import { randomUUID } from "node:crypto";
import { DeliveryError } from "../../src/shared/delivery.ts";
import { WeComGateway, type GatewayPeer } from "../../src/gateway/runtime.ts";
import type { GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import type { BridgeClient, ChatIdentity, GatewayRegistration, GatewayStatus, ServerFrame, TaskState } from "../../src/shared/gateway-protocol.ts";
import { sameTarget, sessionTarget, validWelcome } from "../../src/shared/gateway-protocol.ts";
import type { GatewayNotification, NotificationSource } from "../../src/shared/notification-types.ts";
import type { WeComSocket } from "../../src/gateway/wecom-client.ts";
import type { ChatRef, WeComState } from "../../src/shared/wecom-protocol.ts";

export class LoopbackClient implements BridgeClient {
  private readonly options: GatewayClientOptions;
  private readonly createWebSocket: (url: string) => WeComSocket;
  private readonly registration: GatewayRegistration;
  private gateway: WeComGateway | undefined;
  private peer: GatewayPeer | undefined;
  private registered = false;
  private state: WeComState = "disconnected";
  private detail: string | undefined;
  private readonly watches = new Map<string, (error?: Error, identity?: ChatIdentity) => void>();

  constructor(options: GatewayClientOptions, createWebSocket: (url: string) => WeComSocket) {
    this.options = options;
    this.createWebSocket = createWebSocket;
    const { botId, welcome, allowedUserIds } = options.config;
    this.registration = {
      instanceId: options.instanceId ?? randomUUID(), registrationId: randomUUID(), source: { ...options.source },
      config: { botId, welcome, ...(allowedUserIds ? { allowedUserIds: [...allowedUserIds] } : {}) },
    };
  }

  start(): void {
    if (this.gateway) return;
    const { botId, secret } = this.options.config;
    const gateway = new WeComGateway({ botId, secret, createWebSocket: this.createWebSocket });
    const peer: GatewayPeer = { send: (frame) => { if (this.peer === peer) this.receive(frame); return this.peer === peer; }, close: () => {} };
    this.gateway = gateway;
    this.peer = peer;
    try { gateway.register(this.registration, peer); }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }

  stop(reason = "stopped"): void {
    const gateway = this.gateway;
    const peer = this.peer;
    this.gateway = this.peer = undefined;
    this.registered = false;
    if (gateway && peer) {
      gateway.unregister(this.registration.instanceId, peer);
      gateway.stop();
    }
    for (const finish of [...this.watches.values()]) finish(new Error(`连接已断开：${reason}`));
    this.setState("disconnected", reason);
  }

  isReady(): boolean { return this.registered && this.state === "subscribed"; }

  updateSource(source: NotificationSource): void {
    if (source.sessionId !== this.registration.source.sessionId) throw new Error("session 已改变，必须重新注册网关");
    this.registration.source = { ...source };
    if (this.registered) this.gateway?.updateSource(this.registration.instanceId, source);
  }

  updateWelcome(welcome: string): void {
    if (!validWelcome(welcome)) throw new Error("invalid welcome");
    this.registration.config = { ...this.registration.config, welcome };
    if (this.registered) this.gateway?.updateWelcome(this.registration.instanceId, welcome);
  }

  resume(): void {
    if (!this.gateway) this.start();
    else if (!this.isReady()) this.gateway.resume();
  }

  taskStatus(taskId: string, state: TaskState): boolean {
    if (!this.isReady()) return false;
    this.gateway!.taskStatus(this.registration.instanceId, taskId, state);
    return true;
  }

  notify(chat: ChatRef, notification: GatewayNotification): Promise<void> {
    if (!this.isReady()) return Promise.reject(new DeliveryError("共享网关或企微连接未就绪", "not_sent"));
    return this.gateway!.notify(this.registration.instanceId, chat, notification);
  }

  watchIdentity(timeoutMs: number, signal?: AbortSignal): Promise<ChatIdentity> {
    if (!this.isReady()) return Promise.reject(new Error("共享网关或企微连接未就绪"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, identity?: ChatIdentity) => {
        if (!this.watches.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) { this.gateway?.unwatch(this.registration.instanceId, id); reject(error); }
        else resolve(identity!);
      };
      const onAbort = () => finish(Object.assign(new Error("whoami 已取消"), { name: "AbortError" }));
      const timer = setTimeout(() => finish(Object.assign(new Error("whoami 超时"), { name: "TimeoutError" })), timeoutMs);
      this.watches.set(id, finish);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.gateway!.watch(this.registration.instanceId, id, timeoutMs);
    });
  }

  private receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "registered": this.registered = true; this.status(frame.status); return;
      case "status": this.status(frame.status); return;
      case "task":
        if (sameTarget(frame.target, sessionTarget(this.registration))) this.options.onTask?.(frame.task);
        return;
      case "identity": this.watches.get(frame.id)?.(undefined, frame.identity); return;
      case "log": this.options.log?.(frame.message); return;
    }
  }

  private status(status: GatewayStatus): void {
    this.options.onStatus?.(status);
    this.setState(status.state, status.detail);
  }

  private fail(message: string): void {
    this.stop(message);
    this.options.onError?.(message);
  }

  private setState(state: WeComState, detail?: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.options.onState?.(state, detail);
  }
}
