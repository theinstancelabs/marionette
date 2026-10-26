Pod::Spec.new do |s|
  s.name = 'ArkitModule'
  s.version = '0.1.0'
  s.summary = 'ARKit pose bridge for Marionette'
  s.description = 'Native ARKit world-tracking bridge used by the Marionette iPhone client.'
  s.homepage = 'https://github.com/instance-labs/marionette'
  s.authors = { 'Marionette' => 'engineering@instancelabs.com' }
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '16.4' }
  # CocoaPods validates that a pod has a canonical source. Expo autolinking still
  # resolves this pod from the local module directory during a development build.
  s.source = { :git => 'https://github.com/instance-labs/marionette.git', :tag => s.version.to_s }
  s.source_files = '**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit'
end
