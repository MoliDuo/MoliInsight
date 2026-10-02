# Native clients

Clients for platforms without an SDK package land here, starting with
`clients/swift/` for MoliSwitch (M2). The wire protocol is plain HTTP and JSON
(see `docs/protocol-v1.md`), so a client is small: a sink that batches events,
posts them to `/v1/ingest`, and keeps what could not be sent.
