# ADR 0005: In-process retry with backoff, then a dead-letter topic per consumer group

## Context

Rule 6: retries with backoff, then a dead-letter topic per consumer, plus a replay CLI.

## Decision

`createMessageHandler` wraps every consumer: decode, then run the handler with exponential backoff and full jitter (default 5 attempts, 200 ms base, 10 s cap), then publish to `<groupId>.dlq` with the original bytes plus `x-dlq-*` headers (original topic, partition, offset, attempts, error, time). Messages that cannot be decoded go to the DLQ at once. If the DLQ publish fails, the handler throws, the offset is not committed and the message is redelivered, so a message is never dropped. The replay CLI is built in Phase 4 on top of these headers.

## Trade-offs

- Retrying in-process blocks the partition during backoff. This keeps ordering and is simple. Non-blocking retry topics are possible later.
- Handlers must be idempotent (see ADR 0003), because a retry can follow a partial success.
