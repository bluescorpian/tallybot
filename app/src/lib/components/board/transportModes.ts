// What a light does when unplugged — the one list both the light's Configure pane and the
// flasher's Settings step offer, so the two say the same thing. Each row leads with the
// situation it's for (the reader knows their venue, not the radio protocol) and names the
// mechanism underneath.
export type TransportMode = "wifi" | "notx" | "espnow";

export const TRANSPORT_MODES: { id: TransportMode; label: string; desc: string }[] = [
	{ id: "wifi", label: "Venue Wi-Fi", desc: "Joins a network you choose" },
	{ id: "notx", label: "Always plugged in", desc: "USB only, dark when unplugged" },
	{
		id: "espnow",
		label: "No Wi-Fi, or it's unreliable",
		desc: "ESP-NOW radio, via a bridge board left plugged into this PC",
	},
];

export const BRIDGE_LABEL = "Use as bridge";
export const BRIDGE_DESC = "Stays plugged in here and relays tally to no-Wi-Fi lights. Replaces any current bridge.";
