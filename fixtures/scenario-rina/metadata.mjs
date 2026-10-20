// Mock seed/display metadata, separate from the strict Facility schema.
export default {
  "facilityId": "fac-rina",
  "founderId": "founder-rina",
  "founderName": "Rina (fictional)",
  "countryCode": "MY",
  "capMinor": "1000000",
  "currency": "MYR",
  "reserveFloorBps": 300,
  "createdAt": "2026-10-16T00:00:00Z",
  "snapshotAt": "2026-10-20T12:00:00Z",
  "sourceType": "mock",
  "deploymentId": "final-1",
  "warning": "MOCK UI DATA: no real funds, receipts, verified rules or measured results.",
  "reserveAssumption": "300 bps floor and 500 bps plan reserve are demo choices, not verified tax rates.",
  "sessionId": "01a14202-2800-7000-8000-0000000000aa",
  "orderId": "order-a-001",
  "registry": [
    {
      "payeeId": "spx-logistics",
      "source": "platform",
      "lineKeys": [
        "LOGISTICS"
      ],
      "channels": [
        "shopee"
      ]
    },
    {
      "payeeId": "shopee-ads",
      "source": "platform",
      "lineKeys": [
        "ADS"
      ],
      "channels": [
        "shopee"
      ]
    },
    {
      "payeeId": "shopee-fees",
      "source": "platform",
      "lineKeys": [
        "PLATFORM_FEES"
      ],
      "channels": [
        "shopee"
      ]
    }
  ],
  "approvedBindings": [
    {
      "payeeId": "supplier-a",
      "lineKeys": [
        "SUPPLIER"
      ],
      "authority": "SupplierApproval",
      "cooledAt": "1792108800"
    },
    {
      "payeeId": "printer-kl",
      "lineKeys": [
        "PACKAGING"
      ],
      "authority": "ADD_PAYEE",
      "cooledAt": "1792108800"
    }
  ]
};
