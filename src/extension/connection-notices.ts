/**
 * What the user is told about one registration's connection. The session reports each status it sees;
 * this decides when an outage, a stopped upstream or a recovery deserves a message, once per event.
 */
export type BridgeConnectionStatus = "online" | "reconnecting" | "blocked";

export interface ConnectionObservation {
	/** The registration is usable now (registered, subscribed and the socket is open). */
	ready: boolean;
	/** The shared WeCom connection gave up and waits for /wecom-aibot connect. */
	stopped: boolean;
	detail?: string;
}

const CONNECT_WAIT_MS = 30_000;
const DISCONNECT_NOTICE_MS = 30_000;

export class ConnectionNotices {
	/** A connection has been usable at least once: later states are shown as reconnects. */
	private everSubscribed = false;
	private ready = false;
	private stopped = false;
	/** One deadline for the initial connection or each outage, not one per retry. */
	private timer: ReturnType<typeof setTimeout> | undefined;
	private reported = false;
	private disconnectDetail: string | undefined;

	constructor(private readonly notify: (message: string, type?: "info" | "warning" | "error") => void) {}

	get connectionStatus(): BridgeConnectionStatus | undefined {
		if (this.ready) return "online";
		if (!this.everSubscribed) return undefined;
		return this.stopped ? "blocked" : "reconnecting";
	}

	/** Returns the transitions the session still has to act on (whoami waiters, queued work). */
	update(observation: ConnectionObservation): { becameReady: boolean; becameStopped: boolean } {
		const wasReady = this.ready;
		const wasStopped = this.stopped;
		this.ready = observation.ready;
		this.stopped = observation.stopped;
		if (this.ready) {
			this.clearTimer();
			// The first success is shown only in the footer, even after a slow or refused attempt.
			if (this.everSubscribed && (this.reported || wasStopped)) this.notify("企业微信机器人连接已恢复", "info");
			this.everSubscribed = true;
			this.reported = false;
			this.disconnectDetail = undefined;
		}
		if (this.stopped) this.clearTimer();
		if (this.stopped && !wasStopped) {
			// Also on the first connection: a refused subscription must not leave the bridge silently waiting.
			const reason = observation.detail ?? "企业微信连接已停止";
			const hint = reason.includes("/wecom-aibot connect")
				? ""
				: "。请核对 BotID/Secret（/wecom-aibot setup），然后运行 /wecom-aibot connect 恢复";
			this.reported = true;
			this.notify(`企业微信机器人连接已停止：${reason}${hint}`, "warning");
		} else if (!this.ready && !this.stopped) {
			if (observation.detail) this.disconnectDetail = observation.detail;
			this.arm();
		}
		return { becameReady: this.ready && !wasReady, becameStopped: this.stopped && !wasStopped };
	}

	dispose(): void {
		this.clearTimer();
	}

	private arm(): void {
		if (this.timer || this.reported) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				if (this.ready || this.stopped) return;
				this.reported = true;
				this.notify(
					this.everSubscribed
						? `企业微信机器人连接中断已超过 30 秒${this.disconnectDetail ? `：${this.disconnectDetail}` : ""}。仍在自动重连，可运行 /wecom-aibot log 查看诊断`
						: "企业微信首次连接等待已超过 30 秒。仍在重试，可运行 /wecom-aibot status 和 /wecom-aibot log 查看原因；/wecom-aibot disconnect 可取消。",
					"warning",
				);
			},
			this.everSubscribed ? DISCONNECT_NOTICE_MS : CONNECT_WAIT_MS,
		);
		this.timer.unref();
	}

	private clearTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
