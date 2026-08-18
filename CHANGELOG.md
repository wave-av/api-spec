# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking
- **Search API reconciled to the shipped gateway shape (wave-search).** `POST /search` now takes `{query, namespace?, topK?}` and returns `{results, metadata}` (hybrid dense+sparse RRF) instead of the archived monolith's `types/filters/page` shape; `GET /search/quick`, `GET /search/suggest`, and `POST /search/semantic` are removed. `POST /search/index`, `DELETE /search/index/{id}`, and `GET /search/analytics` are added.
