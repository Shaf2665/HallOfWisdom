import { createHash } from "node:crypto";
import { canonicalCeoPlanContent, type CeoPlanContentInput } from "@hall-of-wisdom/protocol";

/**
 * SHA-256 of `canonicalCeoPlanContent`'s output, hex-encoded — the exact
 * content hash `CeoPlanVersion.contentHash`/`CeoApproval.contentHash`
 * carry. `node:crypto` only, never a browser-facing computation (the
 * protocol package that owns `canonicalCeoPlanContent` stays environment-
 * agnostic — see its own doc comment). This is the one function that
 * decides what "the same plan content" means for approval-binding
 * purposes (Phase 14 kickoff, "Content-hash approval binding"): two plan
 * versions with byte-identical `canonicalCeoPlanContent` output always
 * hash identically, and any real content difference — including a
 * changed `selectedAdapterId`, per the kickoff's "Require a new plan
 * version when the selected adapter changes" — always hashes differently.
 */
export function computeCeoPlanContentHash(input: CeoPlanContentInput): string {
  return createHash("sha256").update(canonicalCeoPlanContent(input)).digest("hex");
}
