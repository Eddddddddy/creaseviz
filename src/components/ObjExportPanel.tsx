import { Box, Download } from 'lucide-react'
import type { ObjScaleMode } from '../lib/objExport'
import type { ObjDetail, ViewerModel } from '../types'

interface Props {
  model?: ViewerModel
  objScaleMode: ObjScaleMode
  objDetail: ObjDetail
  objExporting: boolean
  objExportProgress: number
  objExportMessage?: string
  objExportError?: string
  regionEnabled: boolean
  regionDisabled: boolean
  scaleX: number
  scaleY: number
  scaleZ: number
  onObjScaleMode: (value: ObjScaleMode) => void
  onObjDetail: (value: ObjDetail) => void
  onExportObj: () => void
}

export default function ObjExportPanel(props: Props) {
  return (
    <section className="inspector-section obj-export-section">
      <h2><Box size={17} />模型导出</h2>
      <div className="obj-scale-toggle" role="group" aria-label="OBJ 导出比例">
        <button aria-pressed={props.objScaleMode === 'true'}
          className={props.objScaleMode === 'true' ? 'is-active' : ''}
          disabled={props.objExporting} onClick={() => props.onObjScaleMode('true')}>真实比例</button>
        <button aria-pressed={props.objScaleMode === 'display'}
          className={props.objScaleMode === 'display' ? 'is-active' : ''}
          disabled={props.objExporting} onClick={() => props.onObjScaleMode('display')}>当前显示比例</button>
      </div>
      {props.model?.kind === 'zag' ? (
        <>
          <p className="obj-export-description">OBJ · 毫米 · Z 为高度 · {props.regionEnabled ? '仅导出 XYZ 选区' : '导出完整模型'}</p>
          {props.model.hasSourceData && <label className="field-row">
            <span>导出精度</span>
            <select aria-label="OBJ 导出精度" value={props.objDetail} disabled={props.objExporting}
              onChange={(event) => props.onObjDetail(event.target.value as ObjDetail)}>
              <option value="preview">预览 · 最多 20 万点</option>
              <option value="high">高精度 · 最多 80 万点</option>
              <option value="original">原始采样 · 小选区</option>
            </select>
          </label>}
          <p className="obj-export-note">
            {props.objScaleMode === 'true'
              ? '按 1:1:1 输出，不应用界面中的高度夸张。'
              : `应用 X ${props.scaleX.toFixed(2)}×、Y ${props.scaleY.toFixed(2)}×、Z ${props.scaleZ.toFixed(2)}×。`}
            {' '}{props.model.spikeRepair ? '从当前去尖刺结果生成网格（文件名含 despiked）。' : props.model.hasSourceData ? '从原始高度数据生成网格，小选区保留原始采样。' : '导出当前加载网格。'}
            {' '}保留 UV，不包含高度色或纹理图片。选区边界为开放表面。
          </p>
          {props.objExporting && <div className="obj-export-progress" aria-label={`OBJ 生成进度 ${Math.round(props.objExportProgress * 100)}%`}>
            <i style={{ width: `${props.objExportProgress * 100}%` }} />
          </div>}
          <button className="obj-download-button" disabled={props.regionDisabled} onClick={props.onExportObj}>
            <Download size={15} />
            {props.objExporting ? `正在生成 ${Math.round(props.objExportProgress * 100)}%` : props.regionEnabled ? '下载选区 OBJ' : '下载 OBJ'}
          </button>
          {props.objExportMessage && <p className="obj-export-status is-success">{props.objExportMessage}</p>}
          {props.objExportError && <p className="obj-export-status is-error">{props.objExportError}</p>}
        </>
      ) : <p className="obj-export-note">加载 ZAG 高度场后可导出 OBJ；STL 已是通用三角网格格式。</p>}
    </section>
  )
}
