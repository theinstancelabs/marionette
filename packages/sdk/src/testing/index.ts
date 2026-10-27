/**
 * `@marionette/sdk/testing` (Node only): the real gateway in-process, scriptable phones, and message builders, so a
 * robot's tests run against what it will meet on the day.
 */
export { startGateway, type StartGatewayOptions, type TestGateway } from './gateway.js';
export { SimPhone, type ActOptions, type Placement, type Reply, type SimPhoneOptions } from './sim-phone.js';
export { TEST_GATEWAY, messages } from './messages.js';
