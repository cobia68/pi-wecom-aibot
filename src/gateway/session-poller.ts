/**
 * Asking pis whether they are busy, for a session list: one poll ends when every pi asked has answered or
 * left, or after STATE_TIMEOUT_MS. A pi that does not answer in time is listed with an unknown state.
 */
import { randomUUID } from "node:crypto";
import { type GatewayRegistration, type ServerFrame, sessionTarget } from "../shared/gateway-protocol.ts";
import type { SessionState } from "./session-view.ts";

const STATE_TIMEOUT_MS = 2_000;

export interface PolledMember extends GatewayRegistration {
	peer: { send(frame: ServerFrame): boolean };
}

/** The members still registered as they were when asked, each with its state. */
export type PollFinish<M> = (online: M[], states: SessionState[]) => void;

interface Poll<M> {
	members: M[];
	busy: Map<string, boolean>;
	finish: PollFinish<M>;
	pending: number;
	done: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

export class SessionPoller<M extends PolledMember> {
	private readonly queries = new Map<string, { poll: Poll<M>; instanceId: string }>();
	private readonly current: (member: M) => boolean;

	/** `current`: whether a member is still the one registered under its instance ID. */
	constructor(current: (member: M) => boolean) {
		this.current = current;
	}

	poll(members: M[], finish: PollFinish<M>): void {
		const poll: Poll<M> = { members, busy: new Map(), finish, pending: members.length, done: false };
		const queries = members.map((member) => ({ id: randomUUID(), member }));
		// Registered before the first send: a pi may answer before the loop ends.
		for (const { id, member } of queries) this.queries.set(id, { poll, instanceId: member.instanceId });
		if (queries.length) poll.timer = setTimeout(() => this.finish(poll), STATE_TIMEOUT_MS);
		for (const { id, member } of queries) {
			const request = { action: "state" as const, target: sessionTarget(member) };
			if (!member.peer.send({ type: "request", id, request })) this.answer(id, member.instanceId);
		}
		if (!poll.pending) this.finish(poll);
	}

	/** A pi's answer to one query; false when the request was no poll's. */
	answer(id: string, instanceId: string, busy?: boolean): boolean {
		const query = this.queries.get(id);
		if (query?.instanceId !== instanceId) return false;
		this.queries.delete(id);
		const { poll } = query;
		if (busy !== undefined) poll.busy.set(instanceId, busy);
		poll.pending -= 1;
		if (!poll.pending) this.finish(poll);
		return true;
	}

	/** A pi left: what it was asked is answered as unknown. */
	left(instanceId: string): void {
		for (const [id, query] of [...this.queries]) if (query.instanceId === instanceId) this.answer(id, instanceId);
	}

	stop(): void {
		for (const { poll } of this.queries.values()) clearTimeout(poll.timer);
		this.queries.clear();
	}

	private finish(poll: Poll<M>): void {
		if (poll.done) return;
		poll.done = true;
		clearTimeout(poll.timer);
		for (const [id, query] of [...this.queries]) if (query.poll === poll) this.queries.delete(id);
		// A pi that left or registered again while it was asked is not listed.
		const online = poll.members.filter(this.current);
		poll.finish(
			online,
			online.map((member) => ({ source: member.source, busy: poll.busy.get(member.instanceId) })),
		);
	}
}
