import { devServerSetup } from "../support/dev-server";

// Its own port and state, so it never collides with the integration suite.
export default devServerSetup({ port: 4331, stateName: ".wrangler-test/import" });
