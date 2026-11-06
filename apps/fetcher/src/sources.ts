/**
 * Re-export of the single source list.
 *
 * The archive and the fetcher must agree on the fixed source list exactly. If they drifted,
 * the archive would hold snapshots the fetcher could not sign, or the fetcher would sign
 * items from a source the policy never declared, which the gate would then refuse as
 * UNDECLARED. One definition, two consumers.
 */
export {
  SOURCES,
  activeSources,
  policyGroups,
  type Source,
  type SourceKind,
} from "../../archive/src/sources.js";
