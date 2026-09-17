// Configure before SDK loads
window.dataLayer = window.dataLayer || [];
window.nextReady = window.nextReady || [];

window.nextConfig = {
  // Required: Your Campaign Cart API key
  apiKey: "LLbBgtusfE2zopDcjnOY9NbrlN690zSjuedqQ04J",
  
  // Currency behavior when country changes
  currencyBehavior: 'auto', // 'auto' | 'manual'
  
  // Payment and checkout configuration
  paymentConfig: {
    expressCheckout: {
      enabled: true, // Enable/disable express checkout methods
      requireValidation: true, // Require form validation before express checkout if radio option - not express buttons
      requiredFields: ['email', 'fname', 'lname'], // Fields required for express checkout radio option
      methodOrder: ['paypal', 'apple_pay', 'google_pay'] // Display order of express payment method buttons
    },
    // cardInputConfig: {
    //   fieldType: {
    //     number: "tel",   // 'number' | 'text' | 'tel'
    //     cvv: "tel"
    //   },
    //   numberFormat: "prettyFormat", // 'prettyFormat' | 'plainFormat' | 'maskedFormat'
    //   labels: { number: "", cvv: "" },
    //   titles: { number: "", cvv: "" },
    //   placeholders: { number: "", cvv: "" },
    //   styles: {
    //     number: "",
    //     cvv: "",
    //     placeholder: ""
    //   },
    // }
  },

  // Address and country configuration
  addressConfig: {
    // defaultCountry: "US",              // Low-priority fallback when campaign list is empty
    // showCountries: ["US", "CA", "GB"], // Deprecated – campaign API provides countries; fallback only
    dontShowStates: ["AS", "GU", "PR", "VI"], // State codes to hide from dropdowns
    // AUTOCOMPLETE PROVIDER:
    //   Option 1 (active): NextCommerce — enableAutocomplete: true, leave googleMaps.apiKey empty
    //   Option 2: Google Maps — fill in googleMaps.apiKey below; takes priority when apiKey is non-empty
    //   Option 3: Disabled — remove enableAutocomplete and leave googleMaps.apiKey empty
    enableAutocomplete: true,
  },

  // Google Maps API key — leave empty to use NextCommerce autocomplete (Option 1 above)
  googleMaps: {
    apiKey: "",
    region: "US",
  },

  // Discount codes configuration
  // discounts: {
    // Example discount code
    // SAVE10: {
    //     code: "SAVE10",
    //     type: "percentage", // 'percentage' | 'fixed'
    //     value: 10,
    //     scope: "order", // 'package' | 'order'
    //     description: "10% off entire order",
    //     combinable: true, // Can be combined with other discounts
    //     // Optional: packageIds: [1, 2], // For package-specific discounts
    //     // Optional: minOrderValue: 50, // Minimum order value
    //     // Optional: maxDiscount: 20 // Maximum discount amount
    // }
  // },

  // profiles: {
    // "regular": {
    //     name: "Regular Pricing",
    //     // No mappings needed - uses original package IDs
    // },
    
    // Example: Exit intent save profile
    // "SAVE_5": {
    //     name: "Exit Save 5",
    //     packageMappings: {
    //         // Original ID -> EXIT PACKAGE ID
    //         1: 9,
    //         2: 10,
    //         3: 11,
    //         4: 12,
    //         5: 13,
    //     }
    // },
  // },

  // Default profile to use (if not specified, uses "regular")
  // defaultProfile: "regular",
  
  // Analytics providers configuration
  storeName: 'store-name', // Required for purchase deduplication with NEXT Storefront Meta App
  analytics: {
    enabled: true,
    mode: 'auto', // 'auto' | 'manual' | 'disabled'
    providers: {
      // Next Campaign analytics (always enabled if analytics.enabled is true)
      nextCampaign: {
          enabled: true
      },
      // Google Tag Manager
      // The SDK does not load GTM. Set gtm_id in _data/campaigns.json and the
      // layout injects the container snippet. With enabled: true the SDK pushes
      // dl_* events to window.dataLayer (and window.ElevarDataLayer) for that
      // container to consume. There is no `settings` object for this provider.
      gtm: {
        enabled: false,
        // Optional: blockedEvents: ["dl_purchase"]  (dl_* names only)
      },
      // Facebook Pixel
      facebook: {
        enabled: false,
        settings: {
          pixelId: "YOUR_PIXEL_ID"
        },
        // Optional: blockedEvents: ["PageView"]
      },
      // RudderStack
      rudderstack: {
        enabled: false,
        settings: {
            // RudderStack configuration is handled by the RudderStack SDK itself
            // This just enables the adapter
        },
        // Optional: blockedEvents: ["PageView"]
      },
      // Custom analytics endpoint
      custom: {
        enabled: false,
        settings: {
            endpoint: "https://your-analytics.com/track",
            apiKey: "your-api-key"
        }
      }
    }
  },
  
  // UTM parameter transfer (preserve tracking params)
  utmTransfer: {
    enabled: true,
    applyToExternalLinks: false, // Add UTM params to external links
    debug: false, // Enable debug logging for UTM transfer
    // Optional: excludedDomains: ['example.com', 'test.org'], // Domains to exclude
    // Optional: paramsToCopy: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']
  }
};