export class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	sent: any[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onerror?: (event: { message: string }) => void;
	onclose?: (event: { reason: string; code: number; wasClean: boolean }) => void;
	onSend?: (frame: any) => void;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("socket closed");
		const frame = JSON.parse(data);
		this.sent.push(frame);
		this.onSend?.(frame);
	}

	close(code = 1006, reason = "connection closed"): void {
		this.readyState = 3;
		this.onclose?.({ reason, code, wasClean: code === 1000 });
	}

	receive(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}

	acknowledge(frame = this.sent.at(-1), errcode = 0): void {
		this.receive({ headers: frame.headers, errcode, errmsg: errcode ? "rejected" : "ok" });
	}
}
