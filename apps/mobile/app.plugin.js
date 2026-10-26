const { withInfoPlist } = require('@expo/config-plugins');
module.exports = function withMarionetteArKit(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSCameraUsageDescription = config.modResults.NSCameraUsageDescription || 'Marionette uses the camera through ARKit to estimate phone pose.';
    return config;
  });
};
