const stem = "rally_6";
const parsedJsonAnnotations = {
  "rally_105_resync_v2": {},
  "rally_6_resync_v2": {}
};
let jsonKey = stem;
if (!parsedJsonAnnotations[jsonKey]) {
  const possibleKey = Object.keys(parsedJsonAnnotations).find(k => k.startsWith(stem) || stem.startsWith(k));
  if (possibleKey) jsonKey = possibleKey;
}
console.log("Stem:", stem);
console.log("Matched JSON Key:", jsonKey);
