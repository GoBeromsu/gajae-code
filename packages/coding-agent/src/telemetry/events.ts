import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exactUnlinkDirectAsync, renameNoReplacePathAsync } from "@gajae-code/natives";
import { getTrustedAgentFile } from "@gajae-code/utils";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_INSTALL_ID_FILE = "telemetry-install-id" as const;

export const TELEMETRY_EVENT_NAMES = [
	"update_check_started",
	"update_check_completed",
	"update_install_started",
	"update_install_completed",
	"update_install_failed",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	event: TelemetryEventName;
	installId: string;
	occurredAt: string;
	channel?: "stable" | "nightly";
	result?: "available" | "up_to_date" | "installed" | "failed" | "skipped";
	installMethod?: "bun" | "npm" | "binary" | "migrate";
}
type EventInput = {
	event?: unknown;
	installId?: unknown;
	occurredAt?: unknown;
	channel?: unknown;
	result?: unknown;
	installMethod?: unknown;
	[key: string]: unknown;
};

const EVENT_NAMES = new Set<string>(TELEMETRY_EVENT_NAMES);
const CHANNELS = new Set(["stable", "nightly"]);
const RESULTS = new Set(["available", "up_to_date", "installed", "failed", "skipped"]);
const INSTALL_METHODS = new Set(["bun", "npm", "binary", "migrate"]);
const FORBIDDEN_KEY = /(?:prompt|argv|path|env|secret|account|model|provider|repo|error|hostname|username|machine|ip)/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALL_ID_CLAIM_TIMEOUT_MS = 2_000;
const INSTALL_ID_CLAIM_RECOVERY_MARGIN_MS = 500;
const INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS = INSTALL_ID_CLAIM_TIMEOUT_MS + INSTALL_ID_CLAIM_RECOVERY_MARGIN_MS;
const INSTALL_ID_CLAIM_LEASE_MS = 1_000;
const INSTALL_ID_CLAIM_POLL_INITIAL_MS = 25;
const durableInstallIdPaths = new Map<string, { identity: string; promise: Promise<void> }>();

function hasForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEY.test(key) || hasForbiddenKey(child, seen)) return true;
	}
	return false;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) {
		throw new Error(`invalid telemetry ${field}`);
	}
	return value;
}

/**
 * Serialize only the versioned telemetry allowlist. Unknown fields are never
 * emitted; forbidden fields anywhere in the input fail closed.
 */
export function serializeTelemetryEvent(input: unknown): string {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("telemetry event must be an object");
	}
	if (hasForbiddenKey(input)) throw new Error("telemetry event contains forbidden data");
	const value = input as EventInput;
	const event = requireString(value.event, "event");
	if (!EVENT_NAMES.has(event)) throw new Error("invalid telemetry event");
	const installId = requireString(value.installId, "installId");
	if (!UUID_V4.test(installId)) throw new Error("invalid telemetry installId");
	const occurredAt = requireString(value.occurredAt, "occurredAt");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
		throw new Error("invalid telemetry occurredAt");
	}

	const output: TelemetryEvent = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		event: event as TelemetryEventName,
		installId,
		occurredAt,
	};
	if (value.channel !== undefined) {
		if (typeof value.channel !== "string" || !CHANNELS.has(value.channel))
			throw new Error("invalid telemetry channel");
		output.channel = value.channel as TelemetryEvent["channel"];
	}
	if (value.result !== undefined) {
		if (typeof value.result !== "string" || !RESULTS.has(value.result)) throw new Error("invalid telemetry result");
		output.result = value.result as TelemetryEvent["result"];
	}
	if (value.installMethod !== undefined) {
		if (typeof value.installMethod !== "string" || !INSTALL_METHODS.has(value.installMethod)) {
			throw new Error("invalid telemetry installMethod");
		}
		output.installMethod = value.installMethod as TelemetryEvent["installMethod"];
	}
	return `${JSON.stringify(output)}\n`;
}

async function publishNewInstallId(filePath: string, installId: string): Promise<void> {
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	const handle = await fs.open(tempPath, "wx", 0o600);
	try {
		try {
			await handle.writeFile(`${installId}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await fs.link(tempPath, filePath);
		} catch (error) {
			if (isHardLinkUnsupported(error)) {
				const unsupported = new Error("exclusive hard links are unavailable") as NodeJS.ErrnoException;
				unsupported.code = "EUNSUPPORTED";
				throw unsupported;
			}
			throw error;
		}
		await syncDirectory(path.dirname(filePath));
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

function isHardLinkUnsupported(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "EPERM";
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(directory, "r");
	} catch (error) {
		if (isUnsupportedDirectorySync(error)) return;
		throw error;
	}
	try {
		try {
			await handle.sync();
		} catch (error) {
			if (!isUnsupportedDirectorySync(error)) throw error;
		}
	} finally {
		await handle.close();
	}
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

async function readPublishedInstallId(filePath: string): Promise<string> {
	const existing = (await Bun.file(filePath).text()).trim();
	if (!UUID_V4.test(existing)) throw new Error("telemetry install ID is malformed");
	return existing;
}

async function readExistingInstallId(filePath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (true) {
		try {
			return await readExistingInstallIdSnapshot(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ECLAIMRACE") throw error;
			if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
		}
	}
}

async function readExistingInstallIdSnapshot(filePath: string): Promise<string> {
	const claimPath = `${filePath}.lock`;
	const claimBefore = await readClaimIdentity(claimPath);
	let fileMissing = false;
	try {
		const existing = (await Bun.file(filePath).text()).trim();
		const claimAfter = await readClaimIdentity(claimPath);
		if (UUID_V4.test(existing) && claimBefore === undefined && claimAfter === undefined)
			return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
		if (UUID_V4.test(existing) && claimBefore !== undefined && claimAfter === undefined)
			return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		fileMissing = true;
	}
	if (!(await readClaimIdentity(claimPath))) {
		if (fileMissing) {
			const missing = new Error("telemetry install ID is missing") as NodeJS.ErrnoException;
			missing.code = "ENOENT";
			throw missing;
		}
		throw new Error("telemetry install ID is malformed");
	}
	await waitForClaimRelease(claimPath);
	return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
}

type ClaimState = "publishing" | "committed" | undefined;
type ClaimIdentity = {
	dev: bigint;
	ino: bigint;
	mtimeMs: number;
	token: string;
	state: ClaimState;
	expiresAt: number | undefined;
};

async function readClaimIdentity(claimPath: string): Promise<ClaimIdentity | undefined> {
	let stat: BigIntStats;
	try {
		stat = await fs.lstat(claimPath, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const content = await fs.readFile(claimPath, "utf8");
		const settled = await fs.lstat(claimPath, { bigint: true });
		if (settled.dev !== stat.dev || settled.ino !== stat.ino) throw claimRaceError();
		const parsed = parseClaim(content);
		return {
			dev: settled.dev,
			ino: settled.ino,
			mtimeMs: Number(settled.mtimeMs),
			token: parsed.token,
			state: parsed.state,
			expiresAt: parsed.expiresAt,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw claimRaceError();
		throw error;
	}
}

function claimRaceError(): NodeJS.ErrnoException {
	const error = new Error("telemetry install ID claim changed during observation") as NodeJS.ErrnoException;
	error.code = "ECLAIMRACE";
	return error;
}

async function readPublishedInstallIdWhenUnclaimed(filePath: string, claimPath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (true) {
		const identity = await fs.lstat(filePath, { bigint: true });
		const identityKey = `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}`;
		let durability = durableInstallIdPaths.get(filePath);
		if (durability === undefined || durability.identity !== identityKey) {
			const promise = syncDirectory(path.dirname(filePath));
			durability = { identity: identityKey, promise };
			durableInstallIdPaths.set(filePath, durability);
			promise.catch(() => {
				if (durableInstallIdPaths.get(filePath)?.promise === promise) durableInstallIdPaths.delete(filePath);
			});
		}
		await durability.promise;
		const value = await readPublishedInstallId(filePath);
		const after = await fs.lstat(filePath, { bigint: true });
		const afterKey = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}`;
		if (afterKey !== identityKey) continue;
		try {
			if (await readClaimIdentity(claimPath)) {
				await waitForClaimRelease(claimPath);
				continue;
			}
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ECLAIMRACE") throw error;
			if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
		}
	}
}

async function refreshClaimLease(claimPath: string, token: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		const named = await fs.lstat(claimPath, { bigint: true });
		handle = await fs.open(claimPath, "r+");
		const opened = await handle.stat({ bigint: true });
		if (named.dev !== opened.dev || named.ino !== opened.ino) return;
		const content = await handle.readFile({ encoding: "utf8" });
		const claim = parseClaim(content);
		if (claim.token !== token || claim.state === undefined) return;
		await handle.close();
		handle = await fs.open(claimPath, "r+");
		const reopened = await handle.stat({ bigint: true });
		if (reopened.dev !== named.dev || reopened.ino !== named.ino) return;
		const record = Buffer.from(serializeClaim(token, claim.state));
		await writeClaimRecord(handle, record, Number(reopened.size));
		await handle.sync();
		await handle.utimes(new Date(), new Date());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function assertClaimOwned(
	claimPath: string,
	token: string,
	state: Exclude<ClaimState, undefined>,
): Promise<void> {
	const claim = await readClaimIdentity(claimPath);
	if (claim?.token === token && claim.state === state) return;
	const error = new Error("telemetry install ID claim ownership was lost") as NodeJS.ErrnoException;
	error.code = "ECLAIMLOST";
	throw error;
}

async function transitionClaimCommitted(claimPath: string, token: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		const before = await fs.lstat(claimPath, { bigint: true });
		handle = await fs.open(claimPath, "r+");
		const opened = await handle.stat({ bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("telemetry install ID claim changed");
		const content = await handle.readFile({ encoding: "utf8" });
		if (parseClaim(content).token !== token || parseClaim(content).state !== "publishing")
			throw new Error("telemetry install ID claim changed");
		await handle.close();
		handle = await fs.open(claimPath, "r+");
		const reopened = await handle.stat({ bigint: true });
		if (reopened.dev !== before.dev || reopened.ino !== before.ino)
			throw new Error("telemetry install ID claim changed");
		const record = Buffer.from(serializeClaim(token, "committed"));
		await writeClaimRecord(handle, record, Number(reopened.size));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ECLAIMRACE") throw claimLostError();
		throw error;
	} finally {
		await handle?.close();
	}
	await assertClaimOwned(claimPath, token, "committed");
}

async function syncClaimDurably(claimPath: string, token: string): Promise<void> {
	const handle = await fs.open(claimPath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertClaimOwned(claimPath, token, "committed");
}

async function writeClaimRecord(handle: fs.FileHandle, record: Uint8Array, position: number): Promise<void> {
	let offset = 0;
	while (offset < record.byteLength) {
		const { bytesWritten } = await handle.write(record, offset, record.byteLength - offset, position + offset);
		if (bytesWritten <= 0) throw new Error("telemetry claim generation write made no progress");
		offset += bytesWritten;
	}
}

function claimLostError(): NodeJS.ErrnoException {
	const error = new Error("telemetry install ID claim ownership was lost") as NodeJS.ErrnoException;
	error.code = "ECLAIMLOST";
	return error;
}

function parseClaim(content: string): { token: string; state: ClaimState; expiresAt: number | undefined } {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	else lines.pop();
	for (const line of lines.reverse()) {
		const match = /^([^|\n]+)\|(publishing|committed)(?:\|(\d+))?$/.exec(line);
		if (match)
			return {
				token: match[1],
				state: match[2] as Exclude<ClaimState, undefined>,
				expiresAt: match[3] === undefined ? undefined : Number(match[3]),
			};
	}
	const [token, stateOrExpiry, expiryValue] = content.split("\n", 3);
	const state = stateOrExpiry === "publishing" || stateOrExpiry === "committed" ? stateOrExpiry : undefined;
	const expiry = state === undefined ? stateOrExpiry : expiryValue;
	const expiresAt = expiry === undefined ? undefined : Number(expiry);
	return { token, state, expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined };
}

function serializeClaim(token: string, state: Exclude<ClaimState, undefined>, expiresAt?: number): string {
	return `${token}|${state}${expiresAt === undefined ? "" : `|${expiresAt}`}\n`;
}

async function waitForClaimRelease(
	claimPath: string,
	deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS,
): Promise<void> {
	while (performance.now() < deadline) {
		try {
			const stat = await fs.stat(claimPath, { bigint: true });
			const claim = await readClaimIdentity(claimPath);
			const publishingExpired =
				claim?.state === "publishing" &&
				((claim.expiresAt !== undefined && claim.expiresAt <= Date.now() - INSTALL_ID_CLAIM_LEASE_MS) ||
					(claim.expiresAt === undefined && Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_TIMEOUT_MS));
			const committedStale =
				claim?.state === "committed" &&
				((claim.expiresAt !== undefined && claim.expiresAt <= Date.now()) ||
					(claim.expiresAt === undefined && Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_LEASE_MS));
			if (publishingExpired || committedStale) {
				await reclaimStaleClaim(claimPath, stat, claim);
				continue;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (code === "ECLAIMRACE") continue;
			throw error;
		}
		await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
	}
	throw new Error("telemetry install ID claim did not clear");
}

async function convergeAfterClaim(filePath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (performance.now() < deadline) {
		await waitForClaimRelease(`${filePath}.lock`, deadline);
		try {
			return await readExistingInstallId(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			return await publishPortably(filePath, randomUUID());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ECLAIM" && code !== "EEXIST") throw error;
		}
	}
	throw new Error("telemetry install ID claim did not clear");
}

async function reclaimStaleClaim(claimPath: string, stat: BigIntStats, claim: ClaimIdentity): Promise<void> {
	if (!stat.isFile()) return;
	if (claim.state === "publishing") await syncDirectory(path.dirname(claimPath));
	const currentClaim = await readClaimIdentity(claimPath);
	if (
		currentClaim === undefined ||
		currentClaim.dev !== claim.dev ||
		currentClaim.ino !== claim.ino ||
		currentClaim.token !== claim.token ||
		currentClaim.state !== claim.state ||
		currentClaim.expiresAt !== claim.expiresAt ||
		((currentClaim.state === "publishing" || currentClaim.state === "committed") &&
			(currentClaim.expiresAt === undefined
				? Date.now() - currentClaim.mtimeMs <= INSTALL_ID_CLAIM_TIMEOUT_MS
				: currentClaim.expiresAt > Date.now()))
	)
		return;
	const content = await fs.readFile(claimPath);
	const finalClaim = parseClaim(content.toString("utf8"));
	if (
		finalClaim.token !== claim.token ||
		finalClaim.state !== claim.state ||
		((finalClaim.state === "publishing" || finalClaim.state === "committed") &&
			finalClaim.expiresAt !== undefined &&
			finalClaim.expiresAt > Date.now())
	)
		return;
	const current = await fs.lstat(claimPath, { bigint: true });
	const currentMtimeMs = Number(current.mtimeMs);
	if (
		(finalClaim.state === "publishing" || finalClaim.state === "committed") &&
		(finalClaim.expiresAt === undefined
			? Date.now() - currentMtimeMs <= INSTALL_ID_CLAIM_TIMEOUT_MS
			: finalClaim.expiresAt > Date.now())
	)
		return;
	if (current.dev !== stat.dev || current.ino !== stat.ino) return;
	const result = await exactUnlinkDirectAsync(claimPath, {
		dev: current.dev,
		ino: current.ino,
		nlink: current.nlink,
		size: current.size,
		mtimeNs: current.mtimeNs,
		sha256: createHash("sha256").update(content).digest("hex"),
		quarantineName: `.${path.basename(claimPath)}.${randomUUID()}.quarantine`,
	});
	if (!result.ok && result.code !== "not_found" && result.code !== "identity_mismatch")
		throw new Error(`telemetry stale claim recovery failed: ${result.code ?? "unknown"}`);
}

async function removeOwnedClaim(claimPath: string, token: string): Promise<void> {
	try {
		const stat = await fs.lstat(claimPath, { bigint: true });
		const content = await fs.readFile(claimPath, "utf8");
		if (parseClaim(content).token !== token) return;
		const current = await fs.lstat(claimPath, { bigint: true });
		if (current.dev !== stat.dev || current.ino !== stat.ino) return;
		const result = await exactUnlinkDirectAsync(claimPath, {
			dev: stat.dev,
			ino: stat.ino,
			nlink: stat.nlink,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: createHash("sha256").update(content).digest("hex"),
			quarantineName: `.${path.basename(claimPath)}.${randomUUID()}.quarantine`,
		});
		if (!result.ok && result.code !== "not_found" && result.code !== "identity_mismatch")
			throw new Error(`telemetry claim cleanup failed: ${result.code ?? "unknown"}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function publishWithClaim(filePath: string, installId: string): Promise<string> {
	const claimPath = `${filePath}.lock`;
	const token = randomUUID();
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	const claimTemporaryPath = `${claimPath}.${randomUUID()}.tmp`;
	let ownsClaim = false;
	let publishedFinal = false;
	let committed = false;
	let leaseTimer: NodeJS.Timeout | undefined;
	let heartbeat = Promise.resolve();
	let heartbeatFailure: unknown;
	let heartbeatStopped = false;
	let claim: fs.FileHandle;
	try {
		try {
			claim = await fs.open(claimTemporaryPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				const busy = new Error("telemetry install ID claim is busy") as NodeJS.ErrnoException;
				busy.code = "ECLAIM";
				throw busy;
			}
			throw error;
		}
		try {
			await claim.writeFile(serializeClaim(token, "publishing", Date.now() + INSTALL_ID_CLAIM_LEASE_MS), "utf8");
			await claim.sync();
		} finally {
			await claim.close();
		}
		const claimPublication = await renameNoReplacePathAsync(claimTemporaryPath, claimPath);
		if (!claimPublication.ok) {
			if (claimPublication.code === "destination_exists" || claimPublication.reason === "destination_exists") {
				const busy = new Error("telemetry install ID claim is busy") as NodeJS.ErrnoException;
				busy.code = "ECLAIM";
				throw busy;
			}
			throw new Error(`telemetry install ID claim publication failed: ${claimPublication.reason}`);
		}
		ownsClaim = parseClaim(await Bun.file(claimPath).text()).token === token;
		if (!ownsClaim) throw new Error("telemetry install ID claim changed");
		const scheduleHeartbeat = (): void => {
			if (heartbeatStopped) return;
			leaseTimer = setTimeout(
				() => {
					leaseTimer = undefined;
					heartbeat = refreshClaimLease(claimPath, token)
						.catch(error => {
							heartbeatFailure = error;
						})
						.finally(scheduleHeartbeat);
				},
				Math.max(1, Math.floor(INSTALL_ID_CLAIM_LEASE_MS / 100)),
			);
			leaseTimer.unref();
		};
		scheduleHeartbeat();
		try {
			const existing = await readPublishedInstallId(filePath);
			await syncDirectory(path.dirname(filePath));
			return existing;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(temporaryPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readPublishedInstallId(filePath);
			await syncDirectory(path.dirname(filePath));
			return existing;
		}
		try {
			await handle.writeFile(`${installId}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		await refreshClaimLease(claimPath, token);
		heartbeatStopped = false;
		scheduleHeartbeat();
		await assertClaimOwned(claimPath, token, "publishing");
		const publication = await renameNoReplacePathAsync(temporaryPath, filePath);
		if (!publication.ok) {
			if (publication.code !== "destination_exists")
				throw new Error(`telemetry install ID publication failed: ${publication.reason}`);
			const existing = await readPublishedInstallId(filePath);
			await syncDirectory(path.dirname(filePath));
			return existing;
		}
		publishedFinal = true;
		await assertClaimOwned(claimPath, token, "publishing");
		await syncDirectory(path.dirname(filePath));
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		await transitionClaimCommitted(claimPath, token);
		heartbeatStopped = false;
		scheduleHeartbeat();
		await syncClaimDurably(claimPath, token);
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		committed = true;
		return installId;
	} finally {
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		await fs.rm(claimTemporaryPath, { force: true }).catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		if (ownsClaim && (!publishedFinal || committed)) await removeOwnedClaim(claimPath, token).catch(() => undefined);
	}
}

async function publishPortably(filePath: string, installId: string): Promise<string> {
	try {
		await publishNewInstallId(filePath, installId);
		return installId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EUNSUPPORTED") throw error;
		return publishWithClaim(filePath, installId);
	}
}

/** Load or create a random UUIDv4 that is not derived from machine data. */
export async function getTelemetryInstallId(
	filePath = getTrustedAgentFile(TELEMETRY_INSTALL_ID_FILE),
): Promise<string> {
	try {
		const existing = await readExistingInstallId(filePath);
		if (UUID_V4.test(existing)) {
			await fs.chmod(filePath, 0o600);
			return existing;
		}
		throw new Error("telemetry install ID is malformed");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const generated = randomUUID();
	try {
		return await publishPortably(filePath, generated);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const existing = await readExistingInstallId(filePath);
			await fs.chmod(filePath, 0o600);
			return existing;
		}
		if ((error as NodeJS.ErrnoException).code === "ECLAIM") {
			const existing = await convergeAfterClaim(filePath);
			await fs.chmod(filePath, 0o600);
			return existing;
		}
		throw error;
	}
}
