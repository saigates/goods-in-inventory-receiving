// Suggest a clean SKU code given OEM + description (e.g. "Galaxy S24_256G" "B+")
// and a chosen color. Pattern: BRAND-MODELSHORT-CAPACITY-COLORSHORT
// e.g. SMSG-S24-256-PBK
const OEM_MAP: Record<string, string> = {
  SMSG: 'SMSG',
  SAMSUNG: 'SMSG',
  APL: 'APL',
  APPLE: 'APL',
  GOOG: 'GOOG',
  GOOGLE: 'GOOG',
}

export function parseDescription(description: string | null | undefined): {
  modelShort: string
  modelName: string
  capacity: string | null
} {
  if (!description) return { modelShort: 'UNK', modelName: 'Unknown', capacity: null }
  // Examples:
  //   "Galaxy S24_256G", "Galaxy S24 FE 256G", "GalaxyZ Flip5 512G", "GalaxyZ Fold5_256G"
  const cleaned = description.replace(/_/g, ' ').trim()
  // Capacity: last "<number>G" token
  const capMatch = cleaned.match(/(\d+)\s*G(?:B)?\b/i)
  const capacity = capMatch ? `${capMatch[1]}G` : null

  // Strip the capacity token to get model name
  let modelName = cleaned.replace(/\b\d+\s*G(?:B)?\b/i, '').trim()
  modelName = modelName.replace(/\s+/g, ' ')

  // Map to short codes
  let modelShort = 'UNK'
  const m = modelName.toLowerCase()
  if (m.includes('z flip5') || m.includes('zflip5')) modelShort = 'ZFLIP5'
  else if (m.includes('z fold5') || m.includes('zfold5')) modelShort = 'ZFOLD5'
  else if (m.includes('s24 fe')) modelShort = 'S24FE'
  else if (m.includes('s24 plus') || m.includes('s24+')) modelShort = 'S24P'
  else if (m.includes('s24')) modelShort = 'S24'
  else if (m.includes('s23 fe')) modelShort = 'S23FE'
  else if (m.includes('s23 plus') || m.includes('s23+')) modelShort = 'S23P'
  else if (m.includes('s23')) modelShort = 'S23'
  else if (m.includes('s22 plus') || m.includes('s22+')) modelShort = 'S22P'
  else if (m.includes('s22')) modelShort = 'S22'
  else if (m.includes('s21')) modelShort = 'S21'
  else if (m.includes('s20 fe')) modelShort = 'S20FE'
  else if (m.includes('s20')) modelShort = 'S20'
  else {
    // Fallback: take first uppercase token
    modelShort = (modelName.split(' ').filter(Boolean)[0] || 'UNK').toUpperCase()
  }
  return { modelShort, modelName, capacity }
}

export function colorShortCode(color: string | null | undefined): string {
  if (!color) return 'STD'
  const map: Record<string, string> = {
    'phantom black': 'PBK',
    'black': 'BLK',
    'phantom gray': 'PGY',
    'gray': 'GRY',
    'grey': 'GRY',
    'graphite': 'GRA',
    'silver': 'SLV',
    'white': 'WHT',
    'cream': 'CRM',
    'green': 'GRN',
    'mint': 'MNT',
    'lavender': 'LAV',
    'violet': 'VLT',
    'cloud navy': 'CLD',
    'navy': 'NVY',
    'blue': 'BLU',
    'red': 'RED',
    'pink': 'PNK',
    'gold': 'GLD',
  }
  const k = color.toLowerCase().trim()
  return map[k] || color.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'STD'
}

export function brandFromOem(oem: string | null | undefined): { brandCode: string; brandName: string } {
  if (!oem) return { brandCode: 'UNK', brandName: 'Unknown' }
  const code = OEM_MAP[oem.toUpperCase()] || oem.toUpperCase().slice(0, 4)
  const brandName =
    code === 'SMSG' ? 'Samsung' :
    code === 'APL' ? 'Apple' :
    code === 'GOOG' ? 'Google' :
    oem
  return { brandCode: code, brandName }
}

export function buildSku(opts: {
  oem: string | null | undefined
  description: string | null | undefined
  color?: string | null
}): { sku: string; brand: string; model: string; capacity: string | null; color: string } {
  const { brandCode, brandName } = brandFromOem(opts.oem)
  const { modelShort, modelName, capacity } = parseDescription(opts.description)
  const color = opts.color || 'Phantom Black'
  const colorCode = colorShortCode(color)
  const capPart = capacity ? capacity.replace('G', '') : 'XX'
  const sku = `${brandCode}-${modelShort}-${capPart}-${colorCode}`
  return { sku, brand: brandName, model: modelName, capacity, color }
}
