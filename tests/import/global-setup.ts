import { devServerSetup, testPort } from "../support/dev-server";

// Its own port and state, so it never collides with the integration suite.
export default devServerSetup({ port: testPort(1), stateName: ".wrangler-test/import" });
