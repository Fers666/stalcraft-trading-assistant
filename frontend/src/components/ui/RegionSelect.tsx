import { MenuItem, Select, SelectChangeEvent, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'
import { REGIONS, Region } from '../../constants/regions'

// select.input — Select региона из REGIONS. Регион НИКОГДА не свободный
// TextField (FORM-01). base.css:255-262
export interface RegionSelectProps {
  value: Region
  onChange: (region: Region) => void
  /** Размер контрола (default 'small'). */
  size?: 'small' | 'medium'
  'aria-label'?: string
  sx?: SxProps<Theme>
}

export default function RegionSelect({
  value,
  onChange,
  size = 'small',
  sx,
  ...rest
}: RegionSelectProps) {
  const handleChange = (e: SelectChangeEvent<Region>) => onChange(e.target.value as Region)
  return (
    <Select<Region>
      value={value}
      onChange={handleChange}
      size={size}
      className="mono"
      aria-label={rest['aria-label'] ?? 'Регион'}
      sx={[
        {
          background: tokens.bg2,
          fontFamily: tokens.fontMono,
          fontSize: fs.f12,
          color: tokens.text1,
          '& .MuiSelect-select': { fontFamily: tokens.fontMono },
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {REGIONS.map((r) => (
        <MenuItem key={r} value={r} className="mono">
          {r}
        </MenuItem>
      ))}
    </Select>
  )
}
