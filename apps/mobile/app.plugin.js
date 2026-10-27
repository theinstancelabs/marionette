const { withInfoPlist } = require('expo/config-plugins');
module.exports = function withMarionetteArKit(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSCameraUsageDescription = config.modResults.NSCameraUsageDescription || 'Marionette uses the camera through ARKit to estimate phone pose.';
    config.modResults.NSLocalNetworkUsageDescription = config.modResults.NSLocalNetworkUsageDescription || 'Marionette connects to a computer on your local network to send pose data and receive controls.';
    return config;
  });
};
