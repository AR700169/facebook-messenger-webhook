<!-- markdownlint-disable GHD046 GHD005 -->

# OpenTelemetry instrumentation for Copilot SDK

This guide shows how to add OpenTelemetry tracing to your Copilot SDK applications.

## Quick start — collect traces

The simplest way to collect traces from the Copilot CLI is to enable telemetry when
creating the client. This config launches the CLI process with OpenTelemetry enabled
and forwards the CLI's spans to the configured OTLP endpoint.

<!-- Node.js example -->
```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  telemetry: {
    otlpEndpoint: "http://localhost:4318",
  },
});
```

For language-specific end-to-end examples and trace propagation details, see the
sections below.

## Built-in telemetry support

The SDK has built-in support for configuring OpenTelemetry on the CLI process and
propagating W3C Trace Context between the SDK and CLI. Provide a `TelemetryConfig`
when creating the client to opt in.

<details open>
<summary><strong>Node.js / TypeScript</strong></summary>

<!-- docs-validate: skip -->
```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  telemetry: {
    otlpEndpoint: "http://localhost:4318",
  },
});
```

</details>

<details>
<summary><strong>Python</strong></summary>

<!-- docs-validate: skip -->
```python
from copilot import CopilotClient

client = CopilotClient(
    telemetry={
        "otlp_endpoint": "http://localhost:4318",
    },
)
```

</details>

<details>
<summary><strong>Go</strong></summary>

<!-- docs-validate: skip -->
```go
client := copilot.NewClient(&copilot.ClientOptions{
    Telemetry: &copilot.TelemetryConfig{
        OTLPEndpoint: "http://localhost:4318",
    },
})
```

</details>

### TelemetryConfig options

| Option          | Node.js          | Python            | Go               | .NET             | Java             | Rust              | Description                                                            |
| --------------- | ---------------- | ----------------- | ---------------- | ---------------- | ---------------- | ----------------- | ---------------------------------------------------------------------- |
| OTLP endpoint   | `otlpEndpoint`   | `otlp_endpoint`   | `OTLPEndpoint`   | `OtlpEndpoint`   | `otlpEndpoint`   | `otlp_endpoint`   | OTLP HTTP endpoint URL                                                 |
| OTLP protocol   | `otlpProtocol`   | `otlp_protocol`   | `OTLPProtocol`   | `OtlpProtocol`   | `otlpProtocol`   | `otlp_protocol`   | OTLP HTTP protocol for all signals: `"http/json"` or `"http/protobuf"` |
| File path       | `filePath`       | `file_path`       | `FilePath`       | `FilePath`       | `filePath`       | `file_path`       | File path for JSON-lines trace output                                  |
| Exporter type   | `exporterType`   | `exporter_type`   | `ExporterType`   | `ExporterType`   | `exporterType`   | `exporter_type`   | `"otlp-http"` or `"file"`                                              |
| Source name     | `sourceName`     | `source_name`     | `SourceName`     | `SourceName`     | `sourceName`     | `source_name`     | Instrumentation scope name                                             |
| Capture content | `captureContent` | `capture_content` | `CaptureContent` | `CaptureContent` | `captureContent` | `capture_content` | Whether to capture message content                                     |

The OTLP protocol field configures the CLI's `"otlp-http"` exporter for all signals. Leave it unset to use the CLI default, or set it to `"http/protobuf"` to export protobuf over HTTP.

### Trace context propagation

> **Most users don't need this.** The `TelemetryConfig` above is all you need to collect traces from the CLI. The trace context propagation described in this section is an **advanced feature** for applications that create their own OpenTelemetry spans and want them to appear in the **same distributed trace** as the CLI's spans.

The SDK can propagate W3C Trace Context (`traceparent`/`tracestate`) on JSON-RPC payloads so that your application's spans and the CLI's spans are linked in one distributed trace. This is useful when, for example, you want to see a "handle tool call" span in your app nested inside the CLI's "execute tool" span, or show the SDK call as a child of your request-handling span.

For cost attribution alongside traces, subscribe to `assistant.usage` events and inspect `apiEndpoint` (`AssistantUsageApiEndpoint`) to see whether a turn used Chat Completions, Responses, or Anthropic Messages; see Streaming session events.

#### SDK → CLI (outbound)

For **Node.js**, provide an `onGetTraceContext` callback on the client options. This is only needed if your application already uses `@opentelemetry/api` and you want to link your spans with the CLI's spans. The SDK calls this callback before `session.create`, `session.resume`, and `session.send` RPCs:

<!-- docs-validate: skip -->
```typescript
import { CopilotClient } from "@github/copilot-sdk";
import { propagation, context } from "@opentelemetry/api";

const client = new CopilotClient({
  telemetry: { otlpEndpoint: "http://localhost:4318" },
  onGetTraceContext: () => {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier; // { traceparent: "00-...", tracestate: "..." }
  },
});
```

For **Python**, **Go**, and **.NET**, trace context injection is automatic when the respective OpenTelemetry/Activity API is configured—no callback is needed.

#### CLI → SDK (inbound)

When the CLI invokes a tool handler, the `traceparent` and `tracestate` from the CLI's span are available in all languages:

* **Go**: The `ToolInvocation.TraceContext` field is a `context.Context` with the trace already restored—use it directly as the parent for your spans.
* **Python**: Trace context is automatically restored around the handler via `trace_context()`—child spans are parented to the CLI's span automatically.
* **.NET**: Trace context is automatically restored via `RestoreTraceContext()`—child `Activity` instances are parented to the CLI's span automatically.
* **Node.js**: Since the SDK has no OpenTelemetry dependency, `traceparent` and `tracestate` are passed as raw strings on the `ToolInvocation` object. Restore the context manually if needed:

<!-- docs-validate: skip -->
```typescript
import { defineTool } from "@github/copilot-sdk";
import { propagation, context, trace } from "@opentelemetry/api";

const myTool = defineTool("my-tool", {
  description: "Do work",
  handler: async (args, invocation) => {
    // Restore the CLI's trace context as the active context
    const carrier = {
      traceparent: invocation.traceparent,
      tracestate: invocation.tracestate,
    };
    const parentCtx = propagation.extract(context.active(), carrier);

    // Create a child span under the CLI's span
    const tracer = trace.getTracer("my-app");
    return context.with(parentCtx, () =>
      tracer.startActiveSpan("my-tool", async (span) => {
        try {
          const result = await doWork(args);
          return result;
        } finally {
          span.end();
        }
      })
    );
  },
});

// Tool handlers are registered when the session is created.
const session = await client.createSession({ tools: [myTool] });
```

### End-to-end examples

Below are minimal end-to-end examples showing how to configure an OpenTelemetry tracer provider, export to OTLP HTTP, and link traces with the Copilot CLI spans.

#### Node.js (full example)

Install:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

```javascript
// otel-setup.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

const exporter = new OTLPTraceExporter({
  url: 'http://localhost:4318/v1/traces',
});

const sdk = new NodeSDK({
  traceExporter: exporter,
});

module.exports = { sdk };
```

```javascript
// app.js
const { sdk } = require('./otel-setup');
const { CopilotClient, defineTool } = require('@github/copilot-sdk');
const { propagation, context, trace } = require('@opentelemetry/api');

async function main() {
  await sdk.start();

  const client = new CopilotClient({
    telemetry: { otlpEndpoint: 'http://localhost:4318' },
    onGetTraceContext: () => {
      const carrier = {};
      propagation.inject(context.active(), carrier);
      return carrier;
    },
  });

  const myTool = defineTool('my-tool', {
    handler: async (args, invocation) => {
      const carrier = { traceparent: invocation.traceparent, tracestate: invocation.tracestate };
      const parentCtx = propagation.extract(context.active(), carrier);
      const tracer = trace.getTracer('my-app');

      return context.with(parentCtx, () =>
        tracer.startActiveSpan('my-tool', async (span) => {
          try {
            // Simulate work
            await new Promise((r) => setTimeout(r, 100));
            return { ok: true };
          } finally {
            span.end();
          }
        })
      );
    },
  });

  const session = await client.createSession({ tools: [myTool] });
  // use session...
}

main().catch(console.error);
```

#### Python (full example)

Install (recommended extras):

```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp
```

```python
# otel_setup.py
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry import trace

provider = TracerProvider()
exporter = OTLPSpanExporter(endpoint="http://localhost:4318/v1/traces")
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

# app.py
from copilot import CopilotClient, define_tool
from opentelemetry import trace, propagation

client = CopilotClient(telemetry={"otlp_endpoint": "http://localhost:4318"})

@define_tool("my-tool")
def my_tool_handler(args, invocation):
    # The SDK restores the CLI's trace context for you in Python; child spans
    # will automatically be parented to the CLI's span.
    tracer = trace.get_tracer(__name__)
    with tracer.start_as_current_span("my-tool") as span:
        # do work
        return {"ok": True}
```

#### Go (full example)

Install:

```bash
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp
```

```go
// otel_setup.go
package main

import (
    "context"
    "log"

    "go.opentelemetry.io/otel"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
)

func initTracer() (*sdktrace.TracerProvider, error) {
    ctx := context.Background()
    exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpoint("localhost:4318"))
    if err != nil {
        return nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
    )
    otel.SetTracerProvider(tp)
    return tp, nil
}

// tool handler example
func toolHandler(ctx context.Context, invocation *copilot.ToolInvocation) error {
    // invocation.TraceContext is a context.Context with the CLI's trace restored
    tracer := otel.Tracer("my-app")
    ctx = invocation.TraceContext
    ctx, span := tracer.Start(ctx, "my-tool")
    defer span.End()

    // do work
    return nil
}
```

### Troubleshooting

- Confirm collector reachability: ensure the OTLP endpoint is reachable from your app/CLI (check firewall and correct host/port). When using the OTLP HTTP exporter the typical path is `http://collector:4318/v1/traces`.
- Check OTLP protocol: set `otlpProtocol` / `OTEL_EXPORTER_OTLP_PROTOCOL` to `http/protobuf` when using the protobuf-over-HTTP exporter (recommended). Using `http/json` requires a collector that accepts JSON.
- Verify resource attributes: set a `service.name` (or `SourceName` / `sourceName`) so traces are easily searchable in your backend.
- Sampling: if you have an aggressive sampler (always_off or 0%), spans may be dropped — confirm your sampler settings.
- Authentication / headers: if your collector expects auth headers, ensure the exporter is configured accordingly.

### Privacy & security

- captureContent (captureContent / capture_content) may include user messages and model responses and can expose PII or sensitive data. Only enable in trusted environments and limit retention/access to traces which contain content. Consider redaction or sending spans to a private collector and enable strict RBAC and retention controls.

### Recommended resource attributes

Set these resources on your tracer provider so traces include useful metadata:

- service.name (SourceName)
- service.version
- deployment.environment (prod/staging/dev)

### Per-language dependencies

| Language | Dependency | Notes |
|---|---|---|
| Node.js |—| No dependency; provide `onGetTraceContext` callback for outbound propagation |
| Python | `opentelemetry-api` | Install with `pip install copilot-sdk[telemetry]` |
| Go | `go.opentelemetry.io/otel` | Required dependency |
| .NET |—| Uses built-in `System.Diagnostics.Activity` |
| Java | `io.opentelemetry:opentelemetry-api` | Add this dependency for SDK-based setup; trace context injection is automatic when the OpenTelemetry Java agent or SDK is configured |

## References

* [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
* [OpenTelemetry MCP Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/)
* [OpenTelemetry Python SDK](https://opentelemetry.io/docs/instrumentation/python/)
* [Copilot SDK Documentation](https://github.com/github/copilot-sdk)
