const { withInfoPlist } = require('expo/config-plugins');
module.exports = function withMarionette(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.NSCameraUsageDescription = 'Marionette uses the camera through ARKit to track the phone’s pose, and to scan a gateway’s pairing QR code.';
    // expo-camera (the QR scanner) links the microphone API for video recording, which Marionette never uses; App
    // Store processing rejects a binary that links it without a description.
    config.modResults.NSMicrophoneUsageDescription = 'Marionette doesn’t use the microphone.';
    config.modResults.NSLocalNetworkUsageDescription = 'Marionette finds your robot’s gateway on the local network and connects to it.';
    // Nearby gateways (modules/discovery) browse this Bonjour service; iOS refuses to browse an undeclared one.
    config.modResults.NSBonjourServices = ['_marionette._tcp'];
    return config;
  });
};
