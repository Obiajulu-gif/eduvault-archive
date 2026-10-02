# EduVault API Versioning and Contracts

External and internal contributors rely on stable API response contracts to integrate with EduVault (e.g. for Web3 storage workflows, student records, and marketplace flows).

## Response Contracts
We use OpenAPI (see \docs/openapi.yaml\) to define the exact shape of our core API responses. These schemas act as binding contracts between the API and its consumers.
- All core endpoints MUST have defined schemas in \docs/openapi.yaml\.
- All automated contract tests (e.g. \contract.test.js\) enforce these schemas strictly.

## Versioning Rules
EduVault endpoints are currently on \1\. Breaking changes are strictly prohibited on 1 routes unless they advance the major version.

**What constitutes a breaking change:**
- Removing or renaming an existing field in a response.
- Changing the type of a field (e.g., from \string\ to \object\).
- Changing an endpoint URL or dropping support for an HTTP method.
- Changing the meaning of existing error codes.

**What is NOT a breaking change:**
- Adding new fields to a response object.
- Adding new optional query parameters.
- Adding new endpoints.

## Deprecation Rules
If a route or field must be sunset:
1. It must return a \Warning\ HTTP header (\Warning: 299 - "Deprecated API"\) at least 30 days prior to removal.
2. The endpoint documentation must clearly indicate the new replacement endpoint.
3. Once the sunset period is over, a breaking change is scheduled for the next major version.

## Examples
The \docs/openapi.yaml\ schema provides examples for success and error responses. Our standard error response format complies with RFC 7807 (Problem Details).
