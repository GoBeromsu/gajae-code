import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getTelemetryInstallId, serializeTelemetryEvent } from "../src/telemetry/events";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("telemetry event serializer", () => {
	it("emits only the versioned allowlist", () => {
		const serialized = serializeTelemetryEvent({
			event: "update_check_completed",
			installId: "123e4567-e89b-42d3-a456-426614174000",
			occurredAt: "2026-08-28T17:00:00.000Z",
			channel: "stable",
			result: "up_to_date",
			unknown: "must not be emitted",
		});

		expect(JSON.parse(serialized)).toEqual({
			schemaVersion: 1,
			event: "update_check_completed",
			installId: "123e4567-e89b-42d3-a456-426614174000",
			occurredAt: "2026-08-28T17:00:00.000Z",
			channel: "stable",
			result: "up_to_date",
		});
	});

	it.each([
		{ prompt: "secret prompt", event: "update_check_completed" },
		{ argv: ["gjc", "update"], event: "update_check_completed" },
		{ path: "/home/alice/project", event: "update_check_completed" },
		{ env: { TOKEN: "secret" }, event: "update_check_completed" },
		{ nested: { provider: "secret-provider" }, event: "update_check_completed" },
		{ nested: { arbitraryError: "private failure" }, event: "update_check_completed" },
	])("rejects forbidden data: $", value => {
		expect(() =>
			serializeTelemetryEvent({
				...value,
				installId: "123e4567-e89b-42d3-a456-426614174000",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("forbidden data");
	});

	it("rejects unsupported event and identity values", () => {
		expect(() =>
			serializeTelemetryEvent({
				event: "arbitrary_event",
				installId: "123e4567-e89b-42d3-a456-426614174000",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("invalid telemetry event");
		expect(() =>
			serializeTelemetryEvent({
				event: "update_check_completed",
				installId: "not-a-uuid",
				occurredAt: "2026-08-28T17:00:00.000Z",
			}),
		).toThrow("invalid telemetry installId");
	});
});

describe("telemetry install ID", () => {
	it("creates a random UUIDv4 and reuses it without machine-derived input", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");

		const first = await getTelemetryInstallId(filePath);
		const second = await getTelemetryInstallId(filePath);

		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(second).toBe(first);
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("fails closed on a malformed persisted ID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "derived-from-hostname\n", { mode: 0o600 });

		await expect(getTelemetryInstallId(filePath)).rejects.toThrow("malformed");
	});

	it("tightens permissions when reusing an existing valid ID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		await fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o644 });

		expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("tightens permissions after concurrent creation races", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");

		const ids = await Promise.all([getTelemetryInstallId(filePath), getTelemetryInstallId(filePath)]);

		expect(ids[0]).toBe(ids[1]);
		expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("converges after an empty and partial winner payload", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const originalOpen = fs.open.bind(fs);
		const openSpy = spyOn(fs, "open").mockImplementationOnce(async () => {
			const winner = await originalOpen(filePath, "w", 0o644);
			await winner.close();
			setTimeout(() => {
				void fs
					.writeFile(filePath, "123e4567-e89b-", { mode: 0o644 })
					.then(() => fs.writeFile(filePath, "123e4567-e89b-42d3-a456-426614174000\n", { mode: 0o644 }));
			}, 10);
			const error = new Error("file already exists") as NodeJS.ErrnoException;
			error.code = "EEXIST";
			throw error;
		});

		try {
			expect(await getTelemetryInstallId(filePath)).toBe("123e4567-e89b-42d3-a456-426614174000");
			expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
		} finally {
			openSpy.mockRestore();
		}
	});

	it("fails closed when a raced winner never publishes a valid UUID", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telemetry-test-"));
		tempDirs.push(directory);
		const filePath = path.join(directory, "telemetry-install-id");
		const originalOpen = fs.open.bind(fs);
		const openSpy = spyOn(fs, "open").mockImplementationOnce(async () => {
			const winner = await originalOpen(filePath, "w", 0o600);
			await winner.close();
			const error = new Error("file already exists") as NodeJS.ErrnoException;
			error.code = "EEXIST";
			throw error;
		});

		try {
			await expect(getTelemetryInstallId(filePath)).rejects.toThrow("malformed");
		} finally {
			openSpy.mockRestore();
		}
	});
});
