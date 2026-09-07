/* Browser geolocation helper used when marking attendance. */
async function getLiveLocation() {
  if (!navigator.geolocation) return null;

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => resolve({
        latitude: Number(position.coords.latitude.toFixed(7)),
        longitude: Number(position.coords.longitude.toFixed(7)),
        accuracy: Number(position.coords.accuracy.toFixed(1))
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

function setLocationStatus(elementId, location) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = location
    ? `Location ready (±${Math.round(location.accuracy)}m)`
    : 'Location unavailable';
  element.classList.toggle('location-ready', Boolean(location));
}
