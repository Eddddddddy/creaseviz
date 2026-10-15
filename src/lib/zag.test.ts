import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { ZagArchive } from './zag'

async function syntheticArchive(includeCalibration = true, includePaletteRange = true): Promise<File> {
  const zip = new JSZip()
  const base = 'scan/9eedddb6-0cf2-4021-9ffc-4e46618e365b/0'
  const add = (key: string, bytes: string | Uint8Array) => zip.file(`${base}/${key}/e57e75b1-707b-4a6f-a095-1485b8b95efb`, bytes)
  const uint32 = (value: number) => new Uint8Array(new Uint32Array([value]).buffer)
  const float64 = (value: number) => new Uint8Array(new Float64Array([value]).buffer)
  add('1dd7dd49-2b97-4bb7-bc2f-d3d017ec6473', 'synthetic screen')
  add('6e2be320-a58e-401d-bc0f-f4d3706014f5', uint32(5))
  add('5130c3fd-6e9d-4617-9701-d7cef74e4932', uint32(5))
  if (includePaletteRange) {
    add('636b3524-4d02-423f-a801-7a90e14df721', float64(-0.0001))
    add('71c0b18d-ee9c-4216-a26a-e1ba1dd286b9', float64(0.0001))
  }
  if (includeCalibration) add('584a57f1-1403-48ef-a465-91ec66c829f7', '<Calibration><MeterPerPixel>0.00001</MeterPerPixel><MeterPerUnit>0.00000001</MeterPerUnit></Calibration>')
  add('4d137b4a-bf22-49d5-96a8-9b07b3fc5d02', new Uint8Array(new Int32Array(25).fill(100).buffer))
  add('2c7fd1a8-b42a-41ff-9baa-56760304e826', new Uint8Array(40))
  add('ad3d63d2-2381-45d4-b68d-07d6bb540d5d', new Uint8Array(768).map((_, i) => i % 256))
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return new File([bytes.slice().buffer], 'synthetic.zag')
}

it('accepts ZAG captures without optional device metadata and still loads the calibrated height field', async () => {
  const archive = await ZagArchive.open(await syntheticArchive())
  expect(archive.captures[0]).toMatchObject({ model: '未记录', serial: '未记录', width: 5, height: 5, xyPitchMm: 0.01 })
  const field = await archive.loadCapture(archive.captures[0])
  expect(field.heights).toEqual(new Int32Array(25).fill(100))
})

it('still rejects missing calibration required to interpret physical dimensions', async () => {
  await expect(ZagArchive.open(await syntheticArchive(false))).rejects.toThrow(/缺少字段/)
})

it('accepts an absent saved palette range so display can derive it from measured heights', async () => {
  const archive = await ZagArchive.open(await syntheticArchive(true, false))
  expect(archive.captures[0].paletteMinMm).toBeUndefined()
  expect(archive.captures[0].paletteMaxMm).toBeUndefined()
  expect((await archive.loadCapture(archive.captures[0])).heights).toHaveLength(25)
})
