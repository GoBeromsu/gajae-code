import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
		await fs.link(tempPath, filePath);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

/** Load or create a random UUIDv4 that is not derived from machine data. */
export async function getTelemetryInstallId(
	filePath = getTrustedAgentFile(TELEMETRY_INSTALL_ID_FILE),
): Promise<string> {
	try {
		const existing = (await Bun.file(filePath).text()).trim();
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
		await publishNewInstallId(filePath, generated);
		return generated;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = (await Bun.file(filePath).text()).trim();
		if (!UUID_V4.test(existing)) throw new Error("telemetry install ID is malformed");
		await fs.chmod(filePath, 0o600);
		return existing;
	}
}
