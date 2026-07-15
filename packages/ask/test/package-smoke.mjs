import assert from "node:assert/strict";

import askExtension from "@pi9/ask";

assert.equal(typeof askExtension, "function", "the package root should default-export the Ask extension");
