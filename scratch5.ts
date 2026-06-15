const xml = `
<image id="188" name="frame_000188" width="1920" height="1080">
  <tag label="set" source="manual">
    <attribute name="player_id">15</attribute>
  </tag>
</image>
`;
const parser = new DOMParser();
const xmlDoc = parser.parseFromString(xml, "text/xml");
const tags = xmlDoc.getElementsByTagName("tag");
for (let j = 0; j < tags.length; j++) {
  const attributes = tags[j].getElementsByTagName("attribute");
  let playerId: number | undefined = undefined;
  for (let k = 0; k < attributes.length; k++) {
    if (attributes[k].getAttribute("name") === "player_id") {
      playerId = parseInt(attributes[k].textContent || "", 10);
      if (isNaN(playerId)) playerId = undefined;
    }
  }
  console.log("Player ID:", playerId);
}
