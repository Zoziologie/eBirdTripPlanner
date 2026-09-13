const outdoorsStyle = "mapbox://styles/mapbox/outdoors-v12";
const satelliteStyle = "mapbox://styles/mapbox/satellite-streets-v12";

export class MapStyleControl {
  constructor({ initialStyle, onStyleChange }) {
    this.style = initialStyle;
    this.onStyleChange = onStyleChange;
    this.container = null;
    this.toggleButton = null;
  }

  onAdd() {
    this.container = document.createElement("div");
    this.container.className = "mapboxgl-ctrl mapboxgl-ctrl-group map-style-control";

    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "map-style-control__toggle";
    this.toggleButton.addEventListener("click", () => {
      this.onStyleChange(this.style === satelliteStyle ? outdoorsStyle : satelliteStyle);
    });
    this.container.append(this.toggleButton);
    this.setStyle(this.style);
    return this.container;
  }

  onRemove() {
    this.container?.remove();
    this.container = null;
  }

  setStyle(style) {
    this.style = style;
    const isSatellite = style === satelliteStyle;
    this.toggleButton?.setAttribute(
      "aria-label",
      isSatellite ? "Switch to map view" : "Switch to satellite view",
    );
    this.toggleButton.innerHTML = `<i class="bi ${isSatellite ? "bi-map" : "bi-globe-americas"}" aria-hidden="true"></i>`;
  }
}
