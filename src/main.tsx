import { createRoot } from 'react-dom/client'
import { Foundation } from './integration/Foundation'

const root = document.getElementById('root')
if (!root) throw new Error('Missing Examination Hub root')
createRoot(root).render(<Foundation />)
