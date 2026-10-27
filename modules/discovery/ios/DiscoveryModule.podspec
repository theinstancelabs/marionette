Pod::Spec.new do |s|
  s.name = 'DiscoveryModule'
  s.version = '0.1.0'
  s.summary = 'Bonjour gateway discovery for Marionette'
  s.description = 'Finds Marionette gateways (_marionette._tcp) on the local network and resolves each to an IPv4 address and port.'
  s.homepage = 'https://github.com/instance-labs/marionette'
  s.authors = { 'Marionette' => 'engineering@instancelabs.com' }
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '16.4' }
  # CocoaPods validates that a pod has a canonical source. Expo autolinking still
  # resolves this pod from the local module directory during a development build.
  s.source = { :git => 'https://github.com/instance-labs/marionette.git', :tag => s.version.to_s }
  s.source_files = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network'
end
