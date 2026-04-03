# WAVE API specification

OpenAPI 3.1 specification for the WAVE enterprise streaming platform APIs.

## Overview

Complete API specification covering 34 API modules: streaming, production, analytics, voice, captions, chapters, clips, phone, collaboration, search, and more.

## Usage

```bash
# Preview with Redoc
npx @redocly/cli preview openapi.yaml

# Validate
npx @redocly/cli lint openapi.yaml

# Generate SDKs
npx @openapitools/openapi-generator-cli generate -i openapi.yaml -g typescript-fetch -o ./sdk/typescript
```

## Authentication

All API requests require a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

Get your API key at [wave.online/developers](https://wave.online/developers).

## Related

- [@wave-av/sdk](https://www.npmjs.com/package/@wave-av/sdk) — TypeScript SDK (34 API modules)
- [@wave-av/adk](https://www.npmjs.com/package/@wave-av/adk) — Agent Developer Kit
- [@wave-av/mcp-server](https://www.npmjs.com/package/@wave-av/mcp-server) — MCP server for AI tools
- [@wave-av/cli](https://www.npmjs.com/package/@wave-av/cli) — Command-line interface

## License

MIT
