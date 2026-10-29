import type { ToolCallSummary } from "../types/conversation.ts";

export type WireType = 0 | 1 | 2 | 5;

export interface ProtoField {
  fieldNumber: number;
  wireType: WireType;
  /**
   * For wireType 0: bigint
   * For wireType 1 (fixed64), 2 (length-delimited), 5 (fixed32): Uint8Array
   */
  value: bigint | Uint8Array;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textEncoder = new TextEncoder();

export function encodeVarint(val: bigint | number): Uint8Array {
  let v = typeof val === "number" ? BigInt(val) : val;
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

export function decodeVarint(
  buf: Uint8Array,
  offset: number
): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i]!;
    i++;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result, nextOffset: i };
    }
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

export function decodeProtoFields(buf: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagRes = decodeVarint(buf, offset);
    if (!tagRes) return null;
    offset = tagRes.nextOffset;
    const tag = Number(tagRes.value);
    const fieldNumber = tag >>> 3;
    const wireType = (tag & 0x7) as WireType;
    if (fieldNumber <= 0) return null;

    if (wireType === 0) {
      const valRes = decodeVarint(buf, offset);
      if (!valRes) return null;
      offset = valRes.nextOffset;
      fields.push({ fieldNumber, wireType: 0, value: valRes.value });
    } else if (wireType === 2) {
      const lenRes = decodeVarint(buf, offset);
      if (!lenRes) return null;
      offset = lenRes.nextOffset;
      const length = Number(lenRes.value);
      if (length < 0 || offset + length > buf.length) return null;
      fields.push({
        fieldNumber,
        wireType: 2,
        value: buf.slice(offset, offset + length),
      });
      offset += length;
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) return null;
      fields.push({
        fieldNumber,
        wireType: 1,
        value: buf.slice(offset, offset + 8),
      });
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) return null;
      fields.push({
        fieldNumber,
        wireType: 5,
        value: buf.slice(offset, offset + 4),
      });
      offset += 4;
    } else {
      return null;
    }
  }
  return fields;
}

export function encodeProtoFields(fields: ProtoField[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of fields) {
    const tag = (BigInt(f.fieldNumber) << 3n) | BigInt(f.wireType);
    chunks.push(encodeVarint(tag));
    if (f.wireType === 0) {
      chunks.push(encodeVarint(f.value as bigint));
    } else if (f.wireType === 2) {
      const bytes = f.value as Uint8Array;
      chunks.push(encodeVarint(bytes.length));
      chunks.push(bytes);
    } else {
      chunks.push(f.value as Uint8Array);
    }
  }
  return concatBytes(chunks);
}

export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function decodePackedVarints(buf: Uint8Array): number[] {
  const out: number[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const res = decodeVarint(buf, offset);
    if (!res) break;
    out.push(Number(res.value));
    offset = res.nextOffset;
  }
  return out;
}

export function encodePackedVarints(nums: number[]): Uint8Array {
  return concatBytes(nums.map((n) => encodeVarint(n)));
}

/**
 * Replaces all occurrences of `pattern` with `replacement` in `buf`.
 * When replacing 36-byte ASCII UUIDs with new 36-byte ASCII UUIDs, all
 * protobuf length prefixes remain untouched and valid.
 */
export function replaceBytesAll(
  buf: Uint8Array,
  pattern: Uint8Array,
  replacement: Uint8Array
): Uint8Array {
  if (pattern.length === 0 || buf.length < pattern.length) return buf;

  const matchIndices: number[] = [];
  outer: for (let i = 0; i <= buf.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (buf[i + j] !== pattern[j]) continue outer;
    }
    matchIndices.push(i);
    i += pattern.length - 1;
  }

  if (matchIndices.length === 0) return buf;

  if (pattern.length === replacement.length) {
    const copy = new Uint8Array(buf);
    for (const idx of matchIndices) {
      copy.set(replacement, idx);
    }
    return copy;
  }

  const chunks: Uint8Array[] = [];
  let lastIdx = 0;
  for (const idx of matchIndices) {
    if (idx > lastIdx) {
      chunks.push(buf.slice(lastIdx, idx));
    }
    chunks.push(replacement);
    lastIdx = idx + pattern.length;
  }
  if (lastIdx < buf.length) {
    chunks.push(buf.slice(lastIdx));
  }
  return concatBytes(chunks);
}

export function encodeTimestampProto(date: Date): Uint8Array {
  const ms = date.getTime();
  const seconds = BigInt(Math.floor(ms / 1000));
  const nanos = BigInt((ms % 1000) * 1_000_000);
  const fields: ProtoField[] = [{ fieldNumber: 1, wireType: 0, value: seconds }];
  if (nanos > 0n) {
    fields.push({ fieldNumber: 2, wireType: 0, value: nanos });
  }
  return encodeProtoFields(fields);
}

/**
 * Updates embedded timestamps inside a step's `metadata` (fields 1, 6, 7, 8, 26, 32)
 * and `step_payload` (field 5, which embeds `metadata`) so Antigravity's indexer sorts
 * the newly forked conversation at the very top of the sidebar.
 */
export function updateStepTimestamps(
  metadata: Uint8Array | null,
  stepPayload: Uint8Array | null,
  now: Date
): { metadata: Uint8Array | null; stepPayload: Uint8Array | null } {
  const tsBytes = encodeTimestampProto(now);

  const transformMeta = (metaBuf: Uint8Array): Uint8Array => {
    const fields = decodeProtoFields(metaBuf);
    if (!fields) return metaBuf;

    const out: ProtoField[] = [];
    for (const f of fields) {
      if (
        (f.fieldNumber === 1 ||
          f.fieldNumber === 6 ||
          f.fieldNumber === 7 ||
          f.fieldNumber === 8 ||
          f.fieldNumber === 32) &&
        f.wireType === 2
      ) {
        out.push({ fieldNumber: f.fieldNumber, wireType: 2, value: tsBytes });
      } else if (f.fieldNumber === 26 && f.wireType === 2) {
        const sub26 = decodeProtoFields(f.value as Uint8Array);
        if (sub26) {
          const newSub26: ProtoField[] = sub26.map((entry) => {
            if (entry.fieldNumber === 1 && entry.wireType === 2) {
              const inner = decodeProtoFields(entry.value as Uint8Array);
              if (inner) {
                const updatedInner = inner.map((inf) =>
                  inf.fieldNumber === 2 && inf.wireType === 2
                    ? { fieldNumber: 2, wireType: 2 as const, value: tsBytes }
                    : inf
                );
                return {
                  fieldNumber: 1,
                  wireType: 2 as const,
                  value: encodeProtoFields(updatedInner),
                };
              }
            }
            return entry;
          });
          out.push({
            fieldNumber: 26,
            wireType: 2,
            value: encodeProtoFields(newSub26),
          });
        } else {
          out.push(f);
        }
      } else {
        out.push(f);
      }
    }
    return encodeProtoFields(out);
  };

  const newMeta = metadata ? transformMeta(metadata) : null;
  let newPayload = stepPayload;

  if (stepPayload) {
    const payFields = decodeProtoFields(stepPayload);
    if (payFields) {
      const updatedPayFields = payFields.map((pf) => {
        if (pf.fieldNumber === 5 && pf.wireType === 2) {
          return {
            fieldNumber: 5,
            wireType: 2 as const,
            value: newMeta ?? transformMeta(pf.value as Uint8Array),
          };
        }
        return pf;
      });
      newPayload = encodeProtoFields(updatedPayFields);
    }
  }

  return { metadata: newMeta, stepPayload: newPayload };
}

/**
 * Rebuilds the `raw_summary` protobuf blob in `conversation_summaries.db`
 * with the new title, step count, trajectory ID, conversation ID, and IDLE status.
 */
export function buildUpdatedRawSummary(
  sourceRawSummary: Uint8Array,
  opts: {
    oldConversationId: string;
    newConversationId: string;
    oldTrajectoryId: string;
    newTrajectoryId: string;
    newTitle: string;
    newStepCount: number;
    lastUserInputStepIndex: number;
    now: Date;
  }
): Uint8Array {
  const oldCidBytes = textEncoder.encode(opts.oldConversationId);
  const newCidBytes = textEncoder.encode(opts.newConversationId);
  const oldTidBytes = textEncoder.encode(opts.oldTrajectoryId);
  const newTidBytes = textEncoder.encode(opts.newTrajectoryId);
  const newTitleBytes = textEncoder.encode(opts.newTitle);
  const tsBytes = encodeTimestampProto(opts.now);

  // First replace any embedded UUIDs inside submessages (e.g. field 17 trajectory_metadata)
  let updatedBuf = replaceBytesAll(sourceRawSummary, oldCidBytes, newCidBytes);
  updatedBuf = replaceBytesAll(updatedBuf, oldTidBytes, newTidBytes);

  const fields = decodeProtoFields(updatedBuf);
  if (!fields) {
    return updatedBuf;
  }

  let hasField1 = false;
  let hasField2 = false;
  let hasField3 = false;
  let hasField4 = false;
  let hasField5 = false;
  let hasField15 = false;
  let hasField16 = false;

  const outFields: ProtoField[] = [];
  for (const f of fields) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      hasField1 = true;
      outFields.push({ fieldNumber: 1, wireType: 2, value: newTitleBytes });
    } else if (f.fieldNumber === 2 && f.wireType === 0) {
      hasField2 = true;
      outFields.push({
        fieldNumber: 2,
        wireType: 0,
        value: BigInt(opts.newStepCount),
      });
    } else if (f.fieldNumber === 3 && f.wireType === 2) {
      hasField3 = true;
      outFields.push({ fieldNumber: 3, wireType: 2, value: tsBytes });
    } else if (f.fieldNumber === 4 && f.wireType === 2) {
      hasField4 = true;
      outFields.push({ fieldNumber: 4, wireType: 2, value: newTidBytes });
    } else if (f.fieldNumber === 5 && f.wireType === 0) {
      hasField5 = true;
      // 1 = CASCADE_RUN_STATUS_IDLE
      outFields.push({ fieldNumber: 5, wireType: 0, value: 1n });
    } else if (f.fieldNumber === 15 && f.wireType === 2) {
      hasField15 = true;
      const annotBytes = encodeProtoFields([
        { fieldNumber: 1, wireType: 2, value: newTitleBytes },
        { fieldNumber: 7, wireType: 2, value: tsBytes },
      ]);
      outFields.push({ fieldNumber: 15, wireType: 2, value: annotBytes });
    } else if (f.fieldNumber === 16 && f.wireType === 0) {
      hasField16 = true;
      outFields.push({
        fieldNumber: 16,
        wireType: 0,
        value: BigInt(Math.max(0, opts.lastUserInputStepIndex)),
      });
    } else {
      outFields.push(f);
    }
  }

  if (!hasField1) {
    outFields.unshift({ fieldNumber: 1, wireType: 2, value: newTitleBytes });
  }
  if (!hasField2) {
    outFields.push({
      fieldNumber: 2,
      wireType: 0,
      value: BigInt(opts.newStepCount),
    });
  }
  if (!hasField3) {
    outFields.push({ fieldNumber: 3, wireType: 2, value: tsBytes });
  }
  if (!hasField4) {
    outFields.push({ fieldNumber: 4, wireType: 2, value: newTidBytes });
  }
  if (!hasField5) {
    outFields.push({ fieldNumber: 5, wireType: 0, value: 1n });
  }
  if (!hasField15) {
    const annotBytes = encodeProtoFields([
      { fieldNumber: 1, wireType: 2, value: newTitleBytes },
      { fieldNumber: 7, wireType: 2, value: tsBytes },
    ]);
    outFields.push({ fieldNumber: 15, wireType: 2, value: annotBytes });
  }
  if (!hasField16 && opts.lastUserInputStepIndex >= 0) {
    outFields.push({
      fieldNumber: 16,
      wireType: 0,
      value: BigInt(opts.lastUserInputStepIndex),
    });
  }

  return encodeProtoFields(outFields);
}

/**
 * Encodes a map entry for `agyhub_summaries_proto.pb`:
 * field 1 (wireType 2) -> { sub 1: conversation_id, sub 2: raw_summary }
 */
export function encodeAgyhubMapEntry(
  conversationId: string,
  rawSummary: Uint8Array
): Uint8Array {
  const entryMsg = encodeProtoFields([
    {
      fieldNumber: 1,
      wireType: 2,
      value: textEncoder.encode(conversationId),
    },
    {
      fieldNumber: 2,
      wireType: 2,
      value: rawSummary,
    },
  ]);
  return encodeProtoFields([{ fieldNumber: 1, wireType: 2, value: entryMsg }]);
}

/**
 * Removes all map entries matching `conversationId` from `agyhub_summaries_proto.pb`.
 */
export function removeAgyhubMapEntry(
  protoBuf: Uint8Array,
  conversationId: string
): Uint8Array {
  const topFields = decodeProtoFields(protoBuf);
  if (!topFields) return protoBuf;

  const kept: ProtoField[] = [];
  for (const f of topFields) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      const sub = decodeProtoFields(f.value as Uint8Array);
      const keyField = sub?.find(
        (s) => s.fieldNumber === 1 && s.wireType === 2
      );
      if (keyField) {
        const keyStr = textDecoder.decode(keyField.value as Uint8Array);
        if (keyStr === conversationId) {
          continue;
        }
      }
    }
    kept.push(f);
  }
  return encodeProtoFields(kept);
}

/**
 * Decodes a step payload from `steps.step_payload` when `transcript.jsonl` is unavailable.
 */
export function decodeStepPayload(
  stepType: number,
  payload: Uint8Array
): {
  role: "user" | "agent" | "tool" | "system";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallSummary[];
} {
  const topFields = decodeProtoFields(payload);
  if (!topFields) {
    return { role: "system", content: "" };
  }

  // Step type 14 = USER_INPUT (stored in field 19)
  if (stepType === 14) {
    const f19 = topFields.find((f) => f.fieldNumber === 19 && f.wireType === 2);
    if (f19) {
      const sub = decodeProtoFields(f19.value as Uint8Array) ?? [];
      const f2 = sub.find((s) => s.fieldNumber === 2 && s.wireType === 2);
      if (f2) {
        return {
          role: "user",
          content: textDecoder.decode(f2.value as Uint8Array),
        };
      }
      // Fallback: concatenate text chunks in subfield 3
      const chunks: string[] = [];
      for (const s of sub) {
        if (s.fieldNumber === 3 && s.wireType === 2) {
          const inner = decodeProtoFields(s.value as Uint8Array) ?? [];
          for (const i of inner) {
            if (i.fieldNumber === 1 && i.wireType === 2) {
              chunks.push(textDecoder.decode(i.value as Uint8Array));
            }
          }
        }
      }
      return { role: "user", content: chunks.join("") };
    }
    return { role: "user", content: "" };
  }

  // Step type 15 = PLANNER_RESPONSE (stored in field 20)
  if (stepType === 15) {
    const f20 = topFields.find((f) => f.fieldNumber === 20 && f.wireType === 2);
    if (f20) {
      const sub = decodeProtoFields(f20.value as Uint8Array) ?? [];
      let content = "";
      let thinking: string | undefined;
      const toolCalls: ToolCallSummary[] = [];

      for (const s of sub) {
        if ((s.fieldNumber === 8 || s.fieldNumber === 1) && s.wireType === 2) {
          const text = textDecoder.decode(s.value as Uint8Array);
          if (text) content = text;
        } else if (s.fieldNumber === 3 && s.wireType === 2) {
          thinking = textDecoder.decode(s.value as Uint8Array);
        } else if (s.fieldNumber === 7 && s.wireType === 2) {
          const tcFields = decodeProtoFields(s.value as Uint8Array) ?? [];
          let callId = "";
          let toolName = "";
          let argsPreview = "";
          for (const tf of tcFields) {
            if (tf.fieldNumber === 1 && tf.wireType === 2) {
              callId = textDecoder.decode(tf.value as Uint8Array);
            } else if (tf.fieldNumber === 2 && tf.wireType === 2) {
              toolName = textDecoder.decode(tf.value as Uint8Array);
            } else if (tf.fieldNumber === 3 && tf.wireType === 2) {
              argsPreview = textDecoder
                .decode(tf.value as Uint8Array)
                .slice(0, 160);
            }
          }
          if (toolName) {
            toolCalls.push({ callId, toolName, argsPreview });
          }
        }
      }
      return {
        role: "agent",
        content,
        thinking,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }
    return { role: "agent", content: "" };
  }

  return { role: "tool", content: "" };
}

/**
 * Filters a `gen_metadata.data` protobuf blob so its field 2 (packed varint step indices)
 * only includes step indices `<= targetStepIdx`. Returns `null` if no step indices remain.
 */
export function filterGenMetadataByStep(
  data: Uint8Array,
  targetStepIdx: number
): Uint8Array | null {
  const fields = decodeProtoFields(data);
  if (!fields) return data;

  const out: ProtoField[] = [];
  for (const f of fields) {
    if (f.fieldNumber === 2 && f.wireType === 2) {
      const indices = decodePackedVarints(f.value as Uint8Array);
      const kept = indices.filter((idx) => idx <= targetStepIdx);
      if (kept.length === 0) {
        return null;
      }
      out.push({
        fieldNumber: 2,
        wireType: 2,
        value: encodePackedVarints(kept),
      });
    } else {
      out.push(f);
    }
  }
  return encodeProtoFields(out);
}

/**
 * Extracts the step index from `executor_metadata.data` (field 3 varint) or
 * `parent_references.data` (field 2 varint).
 */
export function extractStepIndexFromMetaBlob(
  data: Uint8Array,
  fieldNum: number
): number | null {
  const fields = decodeProtoFields(data);
  if (!fields) return null;
  const match = fields.find(
    (f) => f.fieldNumber === fieldNum && f.wireType === 0
  );
  return match ? Number(match.value as bigint) : null;
}
