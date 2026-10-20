/**
 * VISION-DECISIONS §4: the five G0 chat data parts stay byte-identical while new parts are added beside them. The
 * inline snapshots below are their JSON Schemas as frozen at G0 (taken before the chat-first parts were added).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatDataPart } from "../src/index";

const G0_TYPES = ["data-question", "data-intent", "data-plan-draft", "data-shortlist", "data-redflag"] as const;

const schemaOf = (type: (typeof G0_TYPES)[number]) => {
  const option = ChatDataPart.options.find((o) => o.shape.type.value === type);
  if (!option) throw new Error(`no ${type} part`);
  return z.toJSONSchema(option);
};

describe("G0 chat data parts (frozen)", () => {
  it("data-question", () => {
    expect(schemaOf("data-question")).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "options": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "label": {
                      "maxLength": 200,
                      "minLength": 1,
                      "type": "string",
                    },
                    "value": {
                      "maxLength": 100,
                      "minLength": 1,
                      "type": "string",
                    },
                  },
                  "required": [
                    "value",
                    "label",
                  ],
                  "type": "object",
                },
                "type": "array",
              },
              "questionId": {
                "description": "Opaque id",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
                "type": "string",
              },
              "slot": {
                "enum": [
                  "countryCode",
                  "residency",
                  "entityType",
                  "productCategory",
                  "sellChannel",
                  "buyFrom",
                  "budgetCeilingMinor",
                  "horizonDays",
                  "adsPacing",
                ],
                "type": "string",
              },
              "text": {
                "maxLength": 500,
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "questionId",
              "slot",
              "text",
              "options",
            ],
            "type": "object",
          },
          "id": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string",
          },
          "transient": {
            "type": "boolean",
          },
          "type": {
            "const": "data-question",
            "type": "string",
          },
        },
        "required": [
          "type",
          "data",
        ],
        "type": "object",
      }
    `);
  });

  it("data-intent", () => {
    expect(schemaOf("data-intent")).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "intent": {
                "additionalProperties": false,
                "properties": {
                  "adsPacing": {
                    "enum": [
                      "conservative",
                      "standard",
                    ],
                    "type": "string",
                  },
                  "answeredSlots": {
                    "items": {
                      "enum": [
                        "countryCode",
                        "residency",
                        "entityType",
                        "productCategory",
                        "sellChannel",
                        "buyFrom",
                        "budgetCeilingMinor",
                        "horizonDays",
                        "adsPacing",
                      ],
                      "type": "string",
                    },
                    "type": "array",
                  },
                  "assumptions": {
                    "items": {
                      "additionalProperties": false,
                      "properties": {
                        "slot": {
                          "enum": [
                            "countryCode",
                            "residency",
                            "entityType",
                            "productCategory",
                            "sellChannel",
                            "buyFrom",
                            "budgetCeilingMinor",
                            "horizonDays",
                            "adsPacing",
                          ],
                          "type": "string",
                        },
                        "text": {
                          "maxLength": 500,
                          "minLength": 1,
                          "type": "string",
                        },
                      },
                      "required": [
                        "slot",
                        "text",
                      ],
                      "type": "object",
                    },
                    "type": "array",
                  },
                  "budgetCeilingMinor": {
                    "description": "User-confirmed budget ceiling",
                    "maxLength": 39,
                    "pattern": "^(0|[1-9][0-9]*)$",
                    "type": "string",
                  },
                  "buyFrom": {
                    "description": "Sourcing country, ISO2 (e.g. CN)",
                    "pattern": "^[A-Z]{2}$",
                    "type": "string",
                  },
                  "countryCode": {
                    "enum": [
                      "MY",
                      "ID",
                      "SG",
                    ],
                    "type": "string",
                  },
                  "entityType": {
                    "enum": [
                      "sole_prop",
                      "partnership",
                      "sdn_bhd",
                      "perorangan",
                      "pt_perorangan",
                      "cv",
                      "pt",
                      "sg_sole_prop",
                      "sg_partnership",
                      "pte_ltd",
                    ],
                    "type": "string",
                  },
                  "horizonDays": {
                    "enum": [
                      30,
                      60,
                      90,
                    ],
                    "type": "number",
                  },
                  "intentVersion": {
                    "const": 1,
                    "type": "number",
                  },
                  "lineEmphasis": {
                    "additionalProperties": false,
                    "properties": {
                      "ADS": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "CONTINGENCY": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "LICENSING": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "LOGISTICS": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "PACKAGING": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "PLATFORM_FEES": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                      "SUPPLIER": {
                        "enum": [
                          "low",
                          "med",
                          "high",
                        ],
                        "type": "string",
                      },
                    },
                    "type": "object",
                  },
                  "productCategory": {
                    "enum": [
                      "drinkware_food_contact",
                      "cosmetics",
                      "electrical",
                      "apparel",
                      "food",
                      "other",
                    ],
                    "type": "string",
                  },
                  "residency": {
                    "enum": [
                      "citizen",
                      "pr",
                      "foreigner",
                    ],
                    "type": "string",
                  },
                  "sellChannel": {
                    "enum": [
                      "shopee",
                      "tiktok_shop",
                      "lazada",
                      "own_site",
                    ],
                    "type": "string",
                  },
                },
                "required": [
                  "intentVersion",
                  "countryCode",
                  "residency",
                  "entityType",
                  "productCategory",
                  "sellChannel",
                  "buyFrom",
                  "budgetCeilingMinor",
                  "horizonDays",
                  "lineEmphasis",
                  "adsPacing",
                  "answeredSlots",
                  "assumptions",
                ],
                "type": "object",
              },
            },
            "required": [
              "intent",
            ],
            "type": "object",
          },
          "id": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string",
          },
          "transient": {
            "type": "boolean",
          },
          "type": {
            "const": "data-intent",
            "type": "string",
          },
        },
        "required": [
          "type",
          "data",
        ],
        "type": "object",
      }
    `);
  });

  it("data-plan-draft", () => {
    expect(schemaOf("data-plan-draft")).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "draftId": {
                "description": "Opaque id",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
                "type": "string",
              },
            },
            "required": [
              "draftId",
            ],
            "type": "object",
          },
          "id": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string",
          },
          "transient": {
            "type": "boolean",
          },
          "type": {
            "const": "data-plan-draft",
            "type": "string",
          },
        },
        "required": [
          "type",
          "data",
        ],
        "type": "object",
      }
    `);
  });

  it("data-shortlist", () => {
    expect(schemaOf("data-shortlist")).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "requestId": {
                "description": "Opaque id",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
                "type": "string",
              },
            },
            "required": [
              "requestId",
            ],
            "type": "object",
          },
          "id": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string",
          },
          "transient": {
            "type": "boolean",
          },
          "type": {
            "const": "data-shortlist",
            "type": "string",
          },
        },
        "required": [
          "type",
          "data",
        ],
        "type": "object",
      }
    `);
  });

  it("data-redflag", () => {
    expect(schemaOf("data-redflag")).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "additionalProperties": false,
        "properties": {
          "data": {
            "additionalProperties": false,
            "properties": {
              "source": {
                "description": "Where it came from, e.g. listing:supplier-c or a URL",
                "maxLength": 300,
                "minLength": 1,
                "type": "string",
              },
              "text": {
                "maxLength": 500,
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "text",
              "source",
            ],
            "type": "object",
          },
          "id": {
            "maxLength": 128,
            "minLength": 1,
            "type": "string",
          },
          "transient": {
            "type": "boolean",
          },
          "type": {
            "const": "data-redflag",
            "type": "string",
          },
        },
        "required": [
          "type",
          "data",
        ],
        "type": "object",
      }
    `);
  });
});
