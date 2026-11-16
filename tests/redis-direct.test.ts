import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRedis,
  RedisReader,
  redisConnection,
} from "../src/storage/redis-direct";

test("Redis RESP handles fragmented Unicode, nested scan replies and null values", async () => {
  const data = encodeRedis(["中文🔑", "contains\r\nline breaks", 42]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < data.length; i += 2)
        controller.enqueue(data.slice(i, i + 2));
      controller.close();
    },
  });
  assert.deepEqual(await new RedisReader(stream.getReader()).read(), [
    "中文🔑",
    "contains\r\nline breaks",
    "42",
  ]);
  const replies = new TextEncoder().encode(
    "*2\r\n$1\r\n0\r\n*2\r\n$3\r\nkey\r\n$-1\r\n",
  );
  const nested = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(replies);
      c.close();
    },
  });
  assert.deepEqual(await new RedisReader(nested.getReader()).read(), [
    "0",
    ["key", null],
  ]);
});

test("Redis protocol errors are bounded and never echo upstream credentials", async () => {
  for (const response of [
    "-WRONGPASS fictional-secret-must-not-echo\r\n",
    "$16777217\r\n",
    "$10\r\nshort",
    "$2\r\nxx!!",
  ]) {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(response));
        c.close();
      },
    });
    await assert.rejects(
      new RedisReader(stream.getReader()).read(),
      (error: any) => {
        assert.equal(error.name, "StorageError");
        assert.equal(error.message.includes("fictional-secret"), false);
        return true;
      },
    );
  }
});

test("Redis connection metadata omits credentials and rejects invalid schemes and destinations", () => {
  const parsed = redisConnection(
    "rediss://default:fictional%40secret@redis.example.test:6380/1",
  );
  assert.equal(parsed.endpoint, "rediss://redis.example.test:6380/1");
  assert.equal(parsed.database, 1);
  for (const input of [
    "https://redis.example.test",
    "redis://redis.example.test",
    "redis://default:fictional@localhost",
    "redis://default:fictional@redis.example.test/20",
    "redis://default:fictional@redis.example.test?password=other",
  ])
    assert.throws(() => redisConnection(input), /Redis|redis/);
});
