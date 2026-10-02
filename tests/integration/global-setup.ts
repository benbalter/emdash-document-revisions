import { devServerSetup, testPort } from "../support/dev-server";

export default devServerSetup({ port: testPort(0), stateName: ".wrangler-test/integration" });
