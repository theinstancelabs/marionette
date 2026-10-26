import { describe, expect, it } from 'vitest';
import { HTML_BRIDGE_VERSION, HTML_CONFIG_VERSION, PROTOCOL_VERSION, matrixToQuaternion, metersToMillimeters, normalizeQuaternion, poseFromTransform, validateAction, validateHtmlBridgeAction, validateHtmlConfig, validatePose } from './index';
describe('protocol', () => {
  it('normalizes quaternions and handles zero safely', () => { expect(normalizeQuaternion({x:0,y:0,z:0,w:0})).toEqual({x:0,y:0,z:0,w:1}); expect(normalizeQuaternion({x:0,y:0,z:0,w:2}).w).toBe(1); });
  it('extracts ARKit translation and identity rotation', () => { const p = poseFromTransform([1,0,0,0,0,1,0,0,0,0,1,0,0.2,0.3,-0.4,1], 's', 1, 2); expect(p.position).toEqual({x:0.2,y:0.3,z:-0.4}); expect(p.rotation.w).toBeCloseTo(1); expect(validatePose(p)).toBe(true); });
  it('rejects stale-shaped or unknown packets', () => { expect(validatePose({type:'pose',version:99})).toBe(false); expect(matrixToQuaternion([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]).w).toBeCloseTo(1); });
  it('converts pose translation to millimetres for operator telemetry', () => { expect(metersToMillimeters({x:0.125,y:-0.002,z:1})).toEqual({x:125,y:-2,z:1000}); });
  it('validates versioned trusted HTML configs and rejects malformed documents', () => {
    const config = { type: 'html_config', version: PROTOCOL_VERSION, sessionId: 'gateway', htmlVersion: HTML_CONFIG_VERSION, bridgeVersion: HTML_BRIDGE_VERSION, html: '<!doctype html><button>Go</button>' };
    expect(validateHtmlConfig(config)).toBe(true);
    expect(validateHtmlConfig({ ...config, bridgeVersion: 99 })).toBe(false);
    expect(validateHtmlConfig({ ...config, html: '' })).toBe(false);
  });
  it('validates WebView bridge actions without allowing arbitrary payloads', () => {
    const bridgeAction = { type: 'action', version: HTML_BRIDGE_VERSION, controlId: 'go', action: 'robot.go', value: true, sentAt: 123 };
    expect(validateHtmlBridgeAction(bridgeAction)).toBe(true);
    expect(validateHtmlBridgeAction({ ...bridgeAction, value: { unsafe: true } })).toBe(false);
    expect(validateAction({ ...bridgeAction, version: PROTOCOL_VERSION, sessionId: 'gateway' })).toBe(true);
  });
});
