// Configure before SDK loads
window.dataLayer = window.dataLayer || [];
window.nextConfig = {
  // Required: Your Campaign Cart API key
  apiKey: "examplekeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  currencyBehavior: 'auto',
  addressConfig: {
    // Option 2: Google Maps — fill in googleMaps.apiKey below
    googleMaps: {
      apiKey: "",
    },
  },
};
