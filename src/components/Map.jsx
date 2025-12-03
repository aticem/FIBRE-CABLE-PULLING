// src/components/Map.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import { MapContainer, GeoJSON, Marker, useMapEvents } from "react-leaflet";
import { DivIcon } from "leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Import custom hooks and components
import useDailyLog from "../hooks/useDailyLog";
import useChartExport from "../hooks/useChartExport";
import SubmitModal from "./SubmitModal";
import ProgressStats from "./ProgressStats";
import HistoryModal from "./HistoryModal";

// Helper function to calculate distance between two coordinates in meters (Haversine formula)
const calculateDistance = (coord1, coord2) => {
  const R = 6371000; // Earth's radius in meters
  const lat1 = coord1[1] * Math.PI / 180;
  const lat2 = coord2[1] * Math.PI / 180;
  const deltaLat = (coord2[1] - coord1[1]) * Math.PI / 180;
  const deltaLng = (coord2[0] - coord1[0]) * Math.PI / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

// Calculate length of a LineString feature in meters
const calculateLineLength = (coordinates) => {
  let totalLength = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    totalLength += calculateDistance(coordinates[i], coordinates[i + 1]);
  }
  return totalLength;
};

// Check if a point is inside bounds
const isPointInBounds = (coord, bounds) => {
  const lat = coord[1];
  const lng = coord[0];
  return lat >= bounds.getSouth() && lat <= bounds.getNorth() &&
         lng >= bounds.getWest() && lng <= bounds.getEast();
};

// Clip a line segment to bounds and return only the part inside
const clipLineToBounds = (coord1, coord2, bounds) => {
  const x1 = coord1[0], y1 = coord1[1];
  const x2 = coord2[0], y2 = coord2[1];
  
  const xmin = bounds.west, xmax = bounds.east;
  const ymin = bounds.south, ymax = bounds.north;
  
  // Cohen-Sutherland algorithm helpers
  const INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;
  
  const computeCode = (x, y) => {
    let code = INSIDE;
    if (x < xmin) code |= LEFT;
    else if (x > xmax) code |= RIGHT;
    if (y < ymin) code |= BOTTOM;
    else if (y > ymax) code |= TOP;
    return code;
  };
  
  let code1 = computeCode(x1, y1);
  let code2 = computeCode(x2, y2);
  let accept = false;
  let cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;
  
  while (true) {
    if (!(code1 | code2)) {
      // Both inside
      accept = true;
      break;
    } else if (code1 & code2) {
      // Both outside same region
      break;
    } else {
      // Line crosses boundary
      let x, y;
      const codeOut = code1 ? code1 : code2;
      
      if (codeOut & TOP) {
        x = cx1 + (cx2 - cx1) * (ymax - cy1) / (cy2 - cy1);
        y = ymax;
      } else if (codeOut & BOTTOM) {
        x = cx1 + (cx2 - cx1) * (ymin - cy1) / (cy2 - cy1);
        y = ymin;
      } else if (codeOut & RIGHT) {
        y = cy1 + (cy2 - cy1) * (xmax - cx1) / (cx2 - cx1);
        x = xmax;
      } else if (codeOut & LEFT) {
        y = cy1 + (cy2 - cy1) * (xmin - cx1) / (cx2 - cx1);
        x = xmin;
      }
      
      if (codeOut === code1) {
        cx1 = x;
        cy1 = y;
        code1 = computeCode(cx1, cy1);
      } else {
        cx2 = x;
        cy2 = y;
        code2 = computeCode(cx2, cy2);
      }
    }
  }
  
  if (accept) {
    return [[cx1, cy1], [cx2, cy2]];
  }
  return null;
};

// Calculate the length of line segments that are inside the bounds (precise clipping)
const calculateLengthInsideBounds = (coordinates, bounds) => {
  let lengthInside = 0;
  
  const boundsObj = {
    south: bounds.getSouth(),
    north: bounds.getNorth(),
    west: bounds.getWest(),
    east: bounds.getEast()
  };
  
  for (let i = 0; i < coordinates.length - 1; i++) {
    const coord1 = coordinates[i];
    const coord2 = coordinates[i + 1];
    
    // Clip line to bounds
    const clipped = clipLineToBounds(coord1, coord2, boundsObj);
    
    if (clipped) {
      // Calculate the length of the clipped segment
      lengthInside += calculateDistance(clipped[0], clipped[1]);
    }
  }
  
  return lengthInside;
};

// Check if a line segment intersects with a bounding box
const lineIntersectsBounds = (coordinates, bounds) => {
  // Check if any point of the line is inside the bounds
  for (const coord of coordinates) {
    if (isPointInBounds(coord, bounds)) {
      return true;
    }
  }
  return false;
};

// Selection Box Component
function SelectionBox({ onSelectionComplete, onUnselectionComplete, visibleLayersRef, geoJsonData, setSelectedBounds, selectedSegments, setSelectedSegments }) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [isUnselecting, setIsUnselecting] = useState(false); // Right-click unselect mode
  const [startPoint, setStartPoint] = useState(null);
  const [currentPoint, setCurrentPoint] = useState(null);
  const selectionRectRef = useRef(null);

  // Prevent context menu on right click to allow unselect functionality
  useEffect(() => {
    const preventContextMenu = (e) => {
      e.preventDefault();
      return false;
    };
    
    document.addEventListener('contextmenu', preventContextMenu);
    return () => {
      document.removeEventListener('contextmenu', preventContextMenu);
    };
  }, []);

  // Check if a point on the line is already selected
  const isPointAlreadySelected = (coord, segments) => {
    const epsilon = 0.00000001; // Small tolerance for floating point comparison
    for (const seg of segments) {
      // Check if point is on or very close to this selected segment
      const [x, y] = coord;
      const [x1, y1] = seg.start;
      const [x2, y2] = seg.end;
      
      // Check if point is between start and end (with some tolerance)
      const minX = Math.min(x1, x2) - epsilon;
      const maxX = Math.max(x1, x2) + epsilon;
      const minY = Math.min(y1, y2) - epsilon;
      const maxY = Math.max(y1, y2) + epsilon;
      
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        // Check if point is on the line segment
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < epsilon) {
          // Segment is a point
          if (Math.abs(x - x1) < epsilon && Math.abs(y - y1) < epsilon) {
            return true;
          }
        } else {
          // Calculate distance from point to line
          const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (len * len)));
          const projX = x1 + t * dx;
          const projY = y1 + t * dy;
          const dist = Math.sqrt((x - projX) * (x - projX) + (y - projY) * (y - projY));
          if (dist < epsilon) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Check if a segment overlaps with already selected segments and return non-overlapping parts
  const getUnselectedPortion = (clippedStart, clippedEnd, segments) => {
    // Simplified: if either endpoint is already selected, skip this segment
    // For more precision, we'd need to split segments
    const startSelected = isPointAlreadySelected(clippedStart, segments);
    const endSelected = isPointAlreadySelected(clippedEnd, segments);
    
    if (startSelected && endSelected) {
      return null; // Entire segment already selected
    }
    
    // For now, return the full clipped segment if any part is new
    return { start: clippedStart, end: clippedEnd };
  };

  // Check if two segments overlap (for unselection)
  const segmentsOverlap = (seg1Start, seg1End, seg2) => {
    const epsilon = 0.0000001;
    const [x1, y1] = seg1Start;
    const [x2, y2] = seg1End;
    const [sx1, sy1] = seg2.start;
    const [sx2, sy2] = seg2.end;
    
    // Check if the segments are on the same line and overlap
    // Simplified: check if any endpoint of one segment is on/near the other
    const isNear = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < epsilon) return Math.abs(px - ax) < epsilon && Math.abs(py - ay) < epsilon;
      
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (len * len)));
      const projX = ax + t * dx;
      const projY = ay + t * dy;
      const dist = Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
      return dist < epsilon;
    };
    
    return isNear(x1, y1, sx1, sy1, sx2, sy2) || 
           isNear(x2, y2, sx1, sy1, sx2, sy2) ||
           isNear(sx1, sy1, x1, y1, x2, y2) ||
           isNear(sx2, sy2, x1, y1, x2, y2);
  };

  // Check if a segment intersects with bounds (any part of segment is inside bounds)
  const segmentIntersectsBounds = (segment, boundsObj) => {
    // Try to clip the segment to bounds - if clipping succeeds, they intersect
    const clipped = clipLineToBounds(segment.start, segment.end, boundsObj);
    return clipped !== null;
  };

  // Clip a segment to bounds and return the clipped portion (if any)
  const clipSegmentToBounds = (segment, boundsObj) => {
    return clipLineToBounds(segment.start, segment.end, boundsObj);
  };

  // Subtract a clipped portion from a segment and return remaining parts
  const subtractFromSegment = (segment, clippedStart, clippedEnd) => {
    const epsilon = 0.0000001;
    const [sx1, sy1] = segment.start;
    const [sx2, sy2] = segment.end;
    const [cx1, cy1] = clippedStart;
    const [cx2, cy2] = clippedEnd;
    
    // Calculate parameter t for each point on the segment line
    const dx = sx2 - sx1;
    const dy = sy2 - sy1;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < epsilon) return []; // Segment is a point
    
    // Project clipped points onto segment to get t values (0 to 1)
    const getT = (px, py) => {
      const t = ((px - sx1) * dx + (py - sy1) * dy) / (len * len);
      return Math.max(0, Math.min(1, t));
    };
    
    const t1 = getT(cx1, cy1);
    const t2 = getT(cx2, cy2);
    const tMin = Math.min(t1, t2);
    const tMax = Math.max(t1, t2);
    
    const remainingParts = [];
    
    // Part before the clipped portion
    if (tMin > epsilon) {
      const endX = sx1 + tMin * dx;
      const endY = sy1 + tMin * dy;
      remainingParts.push({
        start: [sx1, sy1],
        end: [endX, endY]
      });
    }
    
    // Part after the clipped portion
    if (tMax < 1 - epsilon) {
      const startX = sx1 + tMax * dx;
      const startY = sy1 + tMax * dy;
      remainingParts.push({
        start: [startX, startY],
        end: [sx2, sy2]
      });
    }
    
    return remainingParts;
  };

  const map = useMapEvents({
    mousedown: (e) => {
      // Left click = select/measure, Right click = unselect (works in both modes)
      if (e.originalEvent.button === 0) {
        setIsSelecting(true);
        setIsUnselecting(false);
        setStartPoint(e.latlng);
        setCurrentPoint(e.latlng);
        map.dragging.disable();
      } else if (e.originalEvent.button === 2) {
        // Right click unselect works in both modes
        setIsUnselecting(true);
        setIsSelecting(false);
        setStartPoint(e.latlng);
        setCurrentPoint(e.latlng);
        map.dragging.disable();
      }
    },
    mousemove: (e) => {
      if ((isSelecting || isUnselecting) && startPoint) {
        setCurrentPoint(e.latlng);
        
        // Update or create selection rectangle
        const bounds = L.latLngBounds(startPoint, e.latlng);
        let boxColor = '#0066ff'; // Default blue for marking
        if (isUnselecting) {
          boxColor = '#ff0000'; // Red for unselect
        }
        
        if (selectionRectRef.current) {
          selectionRectRef.current.setBounds(bounds);
        } else {
          selectionRectRef.current = L.rectangle(bounds, {
            color: boxColor,
            weight: 2,
            fillColor: boxColor,
            fillOpacity: 0.2,
            dashArray: '5, 5'
          }).addTo(map);
        }
      }
    },
    mouseup: (e) => {
      if ((isSelecting || isUnselecting) && startPoint) {
        const bounds = L.latLngBounds(startPoint, e.latlng);
        const boundsObj = {
          south: bounds.getSouth(),
          north: bounds.getNorth(),
          west: bounds.getWest(),
          east: bounds.getEast()
        };
        
        if (isUnselecting) {
          // UNSELECT MODE - Treat the line as continuous, remove parts inside the box
          // Directly clip each selected segment to the unselect bounds and remove that portion
          let totalLengthRemoved = 0;
          const newSelectedSegments = [];
          
          selectedSegments.forEach(seg => {
            // Check if this segment has any portion inside the unselect box
            const clipped = clipLineToBounds(seg.start, seg.end, boundsObj);
            
            if (clipped) {
              // This segment has a portion inside the unselect box - remove it
              const removedLength = calculateDistance(clipped[0], clipped[1]);
              totalLengthRemoved += removedLength;
              
              // Get remaining parts (parts outside the box)
              const remainingParts = subtractFromSegment(seg, clipped[0], clipped[1]);
              newSelectedSegments.push(...remainingParts);
            } else {
              // Segment is completely outside the box, keep it
              newSelectedSegments.push(seg);
            }
          });
          
          // Update marking segments if any length was removed
          if (totalLengthRemoved > 0) {
            onUnselectionComplete(totalLengthRemoved, [], newSelectedSegments);
          }
        } else {
          // MARKING SELECT MODE - Add segments that are inside the box
          let totalLengthInside = 0;
          const newSelectedSegments = [];
          
          if (geoJsonData.trench) {
            geoJsonData.trench.features.forEach((feature, featureIndex) => {
              if (feature.geometry && feature.geometry.type === "LineString") {
                const coords = feature.geometry.coordinates;
                
                for (let i = 0; i < coords.length - 1; i++) {
                  const coord1 = coords[i];
                  const coord2 = coords[i + 1];
                  
                  // Clip line to bounds
                  const clipped = clipLineToBounds(coord1, coord2, boundsObj);
                  
                  if (clipped) {
                    // Check if this clipped portion overlaps with already selected segments
                    const unselected = getUnselectedPortion(clipped[0], clipped[1], selectedSegments);
                    
                    if (unselected) {
                      const clippedLength = calculateDistance(unselected.start, unselected.end);
                      totalLengthInside += clippedLength;
                      newSelectedSegments.push(unselected);
                    }
                  }
                }
              }
            });
          }
          
          // Call the completion handler with the length inside the box (only new segments)
          if (totalLengthInside > 0) {
            onSelectionComplete(totalLengthInside);
            // Save the bounds for potential future use
            setSelectedBounds(prev => [...prev, boundsObj]);
            // Add new selected segments
            setSelectedSegments(prev => [...prev, ...newSelectedSegments]);
          }
        }
        
        // Clean up
        if (selectionRectRef.current) {
          map.removeLayer(selectionRectRef.current);
          selectionRectRef.current = null;
        }
        
        setIsSelecting(false);
        setIsUnselecting(false);
        setStartPoint(null);
        setCurrentPoint(null);
        
        // Re-enable map dragging
        map.dragging.enable();
      }
    },
    contextmenu: (e) => {
      // Prevent default context menu
      e.originalEvent.preventDefault();
    }
  });

  return null;
}

// SS Station coordinates
const SS_STATIONS = {
  SS01: [-1.657385735167627, 52.685184527503822],
  SS02: [-1.658778597831879, 52.683702838735101],
  SS03: [-1.660892033311022, 52.686941496854956],
  SS04: [-1.661595465931238, 52.68852372875844],
  SS05: [-1.669201311299513, 52.685463263206088],
  SS06: [-1.667897742722671, 52.688613796702931],
  CSS: [-1.654334831002414, 52.685259188363439]
};

// Segment definitions between SS stations (only the requested 6 segments)
const SS_SEGMENTS = [
  { id: 'SS06-SS03', from: 'SS06', to: 'SS03', label: 'SS06-SS03' },
  { id: 'SS05-SS02', from: 'SS05', to: 'SS02', label: 'SS05-SS02' },
  { id: 'SS04-SS01', from: 'SS04', to: 'SS01', label: 'SS04-SS01' },
  { id: 'SS01-CSS', from: 'SS01', to: 'CSS', label: 'SS01-CSS' },
  { id: 'SS02-CSS', from: 'SS02', to: 'CSS', label: 'SS02-CSS' },
  { id: 'SS03-CSS', from: 'SS03', to: 'CSS', label: 'SS03-CSS' }
];

// Build graph from trench.geojson segments for path finding
const buildTrenchGraph = (trenchData) => {
  if (!trenchData) return { nodes: {}, edges: [], nodeCount: 0 };
  
  const nodes = {}; // key: "lng,lat", value: { index, coord }
  let nodeIndex = 0;
  const edges = []; // { from: nodeIdx, to: nodeIdx, length: meters, coords: [start, end] }
  const tolerance = 0.00002; // ~2m tolerance for coordinate matching
  
  // Round coordinates to find nearby points
  const roundCoord = (val) => Math.round(val / tolerance) * tolerance;
  const getNodeKey = (coord) => `${roundCoord(coord[0]).toFixed(6)},${roundCoord(coord[1]).toFixed(6)}`;
  
  const getOrCreateNode = (coord) => {
    const key = getNodeKey(coord);
    if (!nodes[key]) {
      nodes[key] = { index: nodeIndex++, coord: coord };
    }
    return nodes[key].index;
  };
  
  trenchData.features.forEach((feature) => {
    if (feature.geometry && feature.geometry.type === "LineString") {
      const coords = feature.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const fromNode = getOrCreateNode(coords[i]);
        const toNode = getOrCreateNode(coords[i + 1]);
        const length = calculateDistance(coords[i], coords[i + 1]);
        
        // Add edge only if nodes are different
        if (fromNode !== toNode) {
          edges.push({
            from: fromNode,
            to: toNode,
            length: length,
            coords: [coords[i], coords[i + 1]]
          });
        }
      }
    }
  });
  
  return { nodes, edges, nodeCount: nodeIndex };
};

// Find nearest node in graph to a given coordinate
const findNearestNode = (coord, nodes) => {
  let minDist = Infinity;
  let nearestNode = null;
  
  Object.values(nodes).forEach((nodeData) => {
    const dist = calculateDistance(coord, nodeData.coord);
    if (dist < minDist) {
      minDist = dist;
      nearestNode = nodeData.index;
    }
  });
  
  return { nodeIndex: nearestNode, distance: minDist };
};

// Dijkstra's algorithm to find shortest path between two nodes
const findShortestPath = (graph, startNodeIdx, endNodeIdx) => {
  const { nodes, edges, nodeCount } = graph;
  
  if (startNodeIdx === null || endNodeIdx === null || nodeCount === 0) return { path: [], length: 0, segments: [] };
  
  // Build adjacency list
  const adjacency = {};
  for (let i = 0; i < nodeCount; i++) {
    adjacency[i] = [];
  }
  
  edges.forEach((edge, edgeIdx) => {
    adjacency[edge.from].push({ to: edge.to, length: edge.length, edgeIdx });
    adjacency[edge.to].push({ to: edge.from, length: edge.length, edgeIdx }); // Bidirectional
  });
  
  // Dijkstra
  const dist = new Array(nodeCount).fill(Infinity);
  const prev = new Array(nodeCount).fill(-1);
  const prevEdge = new Array(nodeCount).fill(-1);
  const visited = new Array(nodeCount).fill(false);
  
  dist[startNodeIdx] = 0;
  
  for (let i = 0; i < nodeCount; i++) {
    // Find minimum distance unvisited node
    let minDist = Infinity;
    let u = -1;
    for (let j = 0; j < nodeCount; j++) {
      if (!visited[j] && dist[j] < minDist) {
        minDist = dist[j];
        u = j;
      }
    }
    
    if (u === -1 || u === endNodeIdx) break;
    
    visited[u] = true;
    
    // Update distances to neighbors
    adjacency[u].forEach(({ to, length, edgeIdx }) => {
      if (!visited[to] && dist[u] + length < dist[to]) {
        dist[to] = dist[u] + length;
        prev[to] = u;
        prevEdge[to] = edgeIdx;
      }
    });
  }
  
  // Reconstruct path
  if (dist[endNodeIdx] === Infinity) return { path: [], length: 0, segments: [] };
  
  const path = [];
  const segments = [];
  let current = endNodeIdx;
  
  while (current !== startNodeIdx && prev[current] !== -1) {
    path.unshift(current);
    if (prevEdge[current] !== -1) {
      segments.unshift(edges[prevEdge[current]]);
    }
    current = prev[current];
  }
  path.unshift(startNodeIdx);
  
  return { path, length: dist[endNodeIdx], segments };
};

// Calculate path length between two SS stations following TRENCH-LINE
const calculatePathLength = (fromStationCoord, toStationCoord, graph) => {
  if (!graph || graph.nodeCount === 0) return { length: 0, segments: [] };
  
  const startNearest = findNearestNode(fromStationCoord, graph.nodes);
  const endNearest = findNearestNode(toStationCoord, graph.nodes);
  
  const result = findShortestPath(graph, startNearest.nodeIndex, endNearest.nodeIndex);
  
  return { length: result.length, segments: result.segments };
};

export default function Map() {
  const [geoJsonData, setGeoJsonData] = useState({ trench: null, text: null, poli: null });
  const [completedLength, setCompletedLength] = useState(0);
  const [totalLength, setTotalLength] = useState(0);
  const [selectedBounds, setSelectedBounds] = useState([]); // Array of bounds that have been selected
  const [selectedSegments, setSelectedSegments] = useState([]); // Array of {start: [lng, lat], end: [lng, lat]} for green overlay
  const [history, setHistory] = useState([]); // For undo - stores previous states
  const [redoStack, setRedoStack] = useState([]); // For redo - stores undone states
  const [lastMarkedLength, setLastMarkedLength] = useState(0); // Track last marked length for auto-fill
  const [showText, setShowText] = useState(true); // Toggle for text layer visibility
  const [activeSegments, setActiveSegments] = useState([]); // Currently highlighted SS segments (multi-select)
  const [segmentLengths, setSegmentLengths] = useState({}); // Calculated lengths for each segment
  const visibleLayersRef = useRef({});
  const mapRef = useRef(null);
  
  // Modal states
  const [submitModalOpen, setSubmitModalOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  
  // Note states
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [pendingNotePosition, setPendingNotePosition] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [savedNotes, setSavedNotes] = useState(() => {
    // Load notes from localStorage on init
    const stored = localStorage.getItem('mapNotes');
    return stored ? JSON.parse(stored) : [];
  });
  const [editingNote, setEditingNote] = useState(null); // For editing existing notes
  const [editNoteText, setEditNoteText] = useState('');
  
  // Custom hooks for daily log and export
  const { dailyLog, addRecord, deleteRecord, resetLog, updateRecord } = useDailyLog();
  const { exportToExcel, isExporting } = useChartExport();

  // Save notes to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('mapNotes', JSON.stringify(savedNotes));
  }, [savedNotes]);

  // Handle note submission
  const handleNoteSubmit = () => {
    if (pendingNotePosition && noteText.trim()) {
      const newNote = {
        id: Date.now(),
        position: pendingNotePosition,
        text: noteText.trim(),
        date: new Date().toISOString()
      };
      setSavedNotes(prev => [...prev, newNote]);
      setPendingNotePosition(null);
      setNoteText('');
      setIsAddingNote(false);
    }
  };

  // Cancel note
  const handleNoteCancel = () => {
    setPendingNotePosition(null);
    setNoteText('');
    setIsAddingNote(false);
  };

  // Delete a note
  const handleNoteDelete = (noteId) => {
    setSavedNotes(prev => prev.filter(n => n.id !== noteId));
    setEditingNote(null);
  };

  // Open edit modal for a note
  const handleNoteClick = (note) => {
    setEditingNote(note);
    setEditNoteText(note.text);
  };

  // Update note text
  const handleNoteUpdate = () => {
    if (editingNote && editNoteText.trim()) {
      setSavedNotes(prev => prev.map(n => 
        n.id === editingNote.id ? { ...n, text: editNoteText.trim() } : n
      ));
      setEditingNote(null);
      setEditNoteText('');
    }
  };

  // Cancel editing
  const handleEditCancel = () => {
    setEditingNote(null);
    setEditNoteText('');
  };

  // Map click handler for notes
  const NoteClickHandler = () => {
    useMapEvents({
      click: (e) => {
        if (isAddingNote && !pendingNotePosition) {
          setPendingNotePosition([e.latlng.lat, e.latlng.lng]);
        }
      }
    });
    return null;
  };

  useEffect(() => {
    // Load trench.geojson - for path finding and segment calculation
    fetch("/trench.geojson")
      .then((res) => res.json())
      .then((data) => {
        setGeoJsonData(prev => ({ ...prev, trench: data }));
        // Total length will be calculated from 6 segments in the next useEffect
      })
      .catch((err) => {
        console.warn('Failed to load trench.geojson:', err);
      });

    // Load text.geojson - for text labels
    fetch("/text.geojson")
      .then((res) => res.json())
      .then((data) => {
        setGeoJsonData(prev => ({ ...prev, text: data }));
      })
      .catch((err) => {
        console.warn('Failed to load text.geojson:', err);
      });

    // Load poli.geojson - for background
    fetch("/poli.geojson")
      .then((res) => res.json())
      .then((data) => {
        setGeoJsonData(prev => ({ ...prev, poli: data }));
      })
      .catch((err) => {
        console.warn('Failed to load poli.geojson:', err);
      });
  }, []);

  // Calculate segment lengths when trench data is loaded
  // Total = sum of 6 segments (not all trench lines)
  useEffect(() => {
    if (!geoJsonData.trench) return;

    // Build graph from trench.geojson data
    const graph = buildTrenchGraph(geoJsonData.trench);
    
    const lengths = {};
    let segmentsTotal = 0;
    SS_SEGMENTS.forEach(seg => {
      const fromCoord = SS_STATIONS[seg.from];
      const toCoord = SS_STATIONS[seg.to];
      const result = calculatePathLength(fromCoord, toCoord, graph);
      lengths[seg.id] = result.length;
      segmentsTotal += result.length;
    });
    
    setSegmentLengths(lengths);
    // Set total as sum of 6 segments
    setTotalLength(segmentsTotal);
  }, [geoJsonData.trench]);

  // Get line segments between two SS stations (following the actual path)
  const getSegmentsBetweenStations = useCallback((fromStation, toStation) => {
    if (!geoJsonData.trench) return [];
    
    const fromCoord = SS_STATIONS[fromStation];
    const toCoord = SS_STATIONS[toStation];
    
    // Build graph and find path
    const graph = buildTrenchGraph(geoJsonData.trench);
    const result = calculatePathLength(fromCoord, toCoord, graph);
    
    // Convert path segments to the format expected by the UI
    return result.segments.map(seg => ({
      start: seg.coords[0],
      end: seg.coords[1]
    }));
  }, [geoJsonData.trench]);

  // Check if a segment overlaps with any selected (green) segment
  // Uses midpoint check and distance-based overlap detection
  const isSegmentCompleted = useCallback((segStart, segEnd) => {
    if (selectedSegments.length === 0) return false;
    
    // Calculate midpoint of the segment to check
    const midX = (segStart[0] + segEnd[0]) / 2;
    const midY = (segStart[1] + segEnd[1]) / 2;
    
    // Check if midpoint lies on or very close to any selected segment
    return selectedSegments.some(selected => {
      // Calculate distance from midpoint to the selected segment line
      const x1 = selected.start[0], y1 = selected.start[1];
      const x2 = selected.end[0], y2 = selected.end[1];
      
      // Vector from start to end of selected segment
      const dx = x2 - x1;
      const dy = y2 - y1;
      const segLengthSq = dx * dx + dy * dy;
      
      if (segLengthSq === 0) return false; // Degenerate segment
      
      // Project midpoint onto the line, clamped to segment
      const t = Math.max(0, Math.min(1, ((midX - x1) * dx + (midY - y1) * dy) / segLengthSq));
      
      // Closest point on selected segment to midpoint
      const closestX = x1 + t * dx;
      const closestY = y1 + t * dy;
      
      // Distance from midpoint to closest point on segment
      const distSq = (midX - closestX) * (midX - closestX) + (midY - closestY) * (midY - closestY);
      
      // Tolerance: ~3 meters in degrees (approximately 0.00003 degrees)
      const toleranceSq = 0.00003 * 0.00003;
      
      return distSq < toleranceSq;
    });
  }, [selectedSegments]);

  // Generate GeoJSON for highlighted segment
  // Generate GeoJSON for all highlighted segments (multi-select)
  const highlightedSegmentGeoJson = useCallback(() => {
    if (activeSegments.length === 0) return null;
    
    const allFeatures = [];
    activeSegments.forEach(segId => {
      const segment = SS_SEGMENTS.find(s => s.id === segId);
      if (!segment) return;
      
      const segments = getSegmentsBetweenStations(segment.from, segment.to);
      segments.forEach((seg, idx) => {
        allFeatures.push({
          type: "Feature",
          properties: { 
            index: idx,
            segmentId: segId,
            isCompleted: isSegmentCompleted(seg.start, seg.end)
          },
          geometry: {
            type: "LineString",
            coordinates: [seg.start, seg.end]
          }
        });
      });
    });
    
    if (allFeatures.length === 0) return null;
    
    return {
      type: "FeatureCollection",
      features: allFeatures
    };
  }, [activeSegments, getSegmentsBetweenStations, isSegmentCompleted]);

  // Style for highlighted segment - professional cyan/teal
  const highlightedSegmentStyle = useCallback((feature) => {
    const isCompleted = feature.properties?.isCompleted;
    if (isCompleted) {
      return { 
        color: '#00CED1', // Dark cyan - professional
        weight: 9, 
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      };
    }
    return { 
      color: '#00CED1', // Dark cyan
      weight: 7, 
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    };
  }, []);

  // Add breathing class to highlighted segments
  const onEachHighlightedFeature = useCallback((feature, layer) => {
    if (layer._path) {
      layer._path.classList.add('breathing-line');
    }
    // For when the path is created later
    layer.on('add', () => {
      if (layer._path) {
        layer._path.classList.add('breathing-line');
      }
    });
  }, []);

  // Add breathing class to inner (green) segments
  const onEachHighlightedInnerFeature = useCallback((feature, layer) => {
    if (layer._path) {
      layer._path.classList.add('breathing-line-inner');
    }
    layer.on('add', () => {
      if (layer._path) {
        layer._path.classList.add('breathing-line-inner');
      }
    });
  }, []);

  // Inner line style for completed segments (green center)
  const highlightedCompletedInnerStyle = useCallback((feature) => {
    const isCompleted = feature.properties?.isCompleted;
    if (isCompleted) {
      return { 
        color: '#27AE60', // Professional green inner
        weight: 4, 
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round'
      };
    }
    return { 
      color: 'transparent',
      weight: 0,
      opacity: 0 
    };
  }, []);

  // Calculate remaining length
  const remainingLength = Math.max(0, totalLength - completedLength);
  const completedPercentage = totalLength > 0 ? (completedLength / totalLength * 100).toFixed(1) : 0;

  // Handle selection box completion - add length inside the box
  const handleSelectionComplete = useCallback((lengthInside) => {
    // Save current state to history before making changes
    setHistory(prev => [...prev, { completedLength, selectedBounds, selectedSegments: [...selectedSegments] }]);
    setRedoStack([]); // Clear redo stack on new action
    
    // Save the last marked length for auto-fill in submit modal
    setLastMarkedLength(lengthInside);
    
    setCompletedLength(prev => {
      const newCompleted = prev + lengthInside;
      // Don't exceed total length
      return Math.min(newCompleted, totalLength);
    });
  }, [totalLength, completedLength, selectedBounds, selectedSegments]);

  // Handle unselection - remove only the selected portion, keep the rest
  const handleUnselectionComplete = useCallback((lengthRemoved, segmentIndicesToRemove, newSegments) => {
    // Save current state to history before making changes
    setHistory(prev => [...prev, { completedLength, selectedBounds, selectedSegments: [...selectedSegments] }]);
    setRedoStack([]); // Clear redo stack on new action
    
    // Replace segments with the new list (remaining parts after subtraction)
    setSelectedSegments(newSegments);
    
    setCompletedLength(prev => {
      const newCompleted = prev - lengthRemoved;
      // Don't go below 0
      return Math.max(0, newCompleted);
    });
  }, [completedLength, selectedBounds, selectedSegments]);

  // Undo function
  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    
    const lastState = history[history.length - 1];
    
    // Save current state to redo stack
    setRedoStack(prev => [...prev, { completedLength, selectedBounds, selectedSegments: [...selectedSegments] }]);
    
    // Restore previous state
    setCompletedLength(lastState.completedLength);
    setSelectedBounds(lastState.selectedBounds);
    setSelectedSegments(lastState.selectedSegments);
    
    // Remove last item from history
    setHistory(prev => prev.slice(0, -1));
  }, [history, completedLength, selectedBounds, selectedSegments]);

  // Redo function
  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    
    const nextState = redoStack[redoStack.length - 1];
    
    // Save current state to history
    setHistory(prev => [...prev, { completedLength, selectedBounds, selectedSegments: [...selectedSegments] }]);
    
    // Restore next state
    setCompletedLength(nextState.completedLength);
    setSelectedBounds(nextState.selectedBounds);
    setSelectedSegments(nextState.selectedSegments);
    
    // Remove last item from redo stack
    setRedoStack(prev => prev.slice(0, -1));
  }, [redoStack, completedLength, selectedBounds, selectedSegments]);

  // Keyboard shortcuts (Ctrl+Z for Undo, Ctrl+Y for Redo)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          handleUndo();
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          handleRedo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  // Create GeoJSON for selected (green) segments - shows only the actually selected portions
  const selectedGeoJson = useCallback(() => {
    if (selectedSegments.length === 0) return null;
    
    const selectedFeatures = selectedSegments.map(seg => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [seg.start, seg.end]
      }
    }));
    
    return {
      type: "FeatureCollection",
      features: selectedFeatures
    };
  }, [selectedSegments]);

  const greenLineStyle = () => ({
    color: '#2ECC71', // Professional emerald green
    weight: 5,
    opacity: 1,
    lineCap: 'round',
    lineJoin: 'round'
  });

  const onEachFeature = (feature, layer) => {
    if (feature.properties && feature.properties.text) {
      layer.bindPopup(feature.properties.text);
    }
  };

  const onEachTrenchLineFeature = useCallback((feature, layer) => {
    if (feature.properties && feature.properties.layer === "Base Zanjas MT_CIVIL_H$0$C-STRM-CNTR") {
      const key = feature.properties.fid ?? feature.properties.handle ?? JSON.stringify(feature.geometry);
      visibleLayersRef.current[key] = layer;
    }
  }, []);

  const style = (feature) => {
    if (feature.properties && feature.properties.color) {
      const colorMatch = feature.properties.color.match(/(\d+),(\d+),(\d+),\d+/);
      if (colorMatch) {
        return {
          color: `rgb(${colorMatch[1]},${colorMatch[2]},${colorMatch[3]})`,
          weight: 2,
          opacity: 1
        };
      }
    }
    return { color: 'blue', weight: 2, opacity: 1 };
  };

  const trenchLineStyle = useCallback((feature) => {
    return { 
      color: '#D4A017', // Professional golden yellow
      weight: 4, 
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    };
  }, []);

  const poliStyle = useCallback((feature) => {
    return { 
      color: '#8B008B', // Dark magenta - more professional
      weight: 1.5, 
      opacity: 0.6,
      lineCap: 'round',
      lineJoin: 'round'
    };
  }, []);

  const createTextIcon = (text) => {
    return new DivIcon({
      html: `<div style="font-size: 11px; font-weight: 500; color: #333; background: rgba(255,255,255,0.75); padding: 1px 4px; border-radius: 2px; border: 1px solid #999; white-space: nowrap; pointer-events: none;">${text}</div>`,
      className: 'custom-text-icon',
      iconSize: [text.length * 7, 18],
      iconAnchor: [text.length * 3.5, 9]
    });
  };

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative" }}>
      {/* SS Segments Panel - Left Side */}
      <div style={{
        position: "absolute",
        top: "10px",
        left: "10px",
        zIndex: 1000,
        backgroundColor: "white",
        padding: "10px 15px",
        borderRadius: "8px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
        fontFamily: "Arial, sans-serif",
        fontSize: "13px",
        maxHeight: "calc(100vh - 40px)",
        overflowY: "auto",
        minWidth: "180px"
      }}>
        <div style={{ fontWeight: "bold", marginBottom: "10px", borderBottom: "1px solid #ddd", paddingBottom: "8px" }}>
          📍 SS Segments
        </div>
        {SS_SEGMENTS.map((segment) => {
          const isSelected = activeSegments.includes(segment.id);
          return (
            <div
              key={segment.id}
              onClick={() => {
                // Toggle segment selection (multi-select)
                if (isSelected) {
                  setActiveSegments(prev => prev.filter(id => id !== segment.id));
                } else {
                  setActiveSegments(prev => [...prev, segment.id]);
                }
              }}
              style={{
                padding: "8px 10px",
                marginBottom: "4px",
                borderRadius: "6px",
                cursor: "pointer",
                backgroundColor: isSelected ? "#E0FFFF" : "#f8f9fa",
                color: isSelected ? "#006666" : "#333",
                fontWeight: isSelected ? "600" : "normal",
                transition: "all 0.2s",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                border: isSelected ? "2px solid #00CED1" : "1px solid #e0e0e0"
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.backgroundColor = "#f0f0f0";
                  e.currentTarget.style.borderColor = "#ccc";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.backgroundColor = "#f8f9fa";
                  e.currentTarget.style.borderColor = "#e0e0e0";
                }
              }}
            >
              <span>{segment.label}</span>
              <span style={{ 
                fontSize: "11px", 
                color: isSelected ? "#008B8B" : "#666",
                fontWeight: "bold"
              }}>
                {segmentLengths[segment.id] ? `${segmentLengths[segment.id].toFixed(1)}m` : "..."}
              </span>
            </div>
          );
        })}
        {activeSegments.length > 0 && (
          <div style={{
            marginTop: "10px",
            padding: "10px",
            backgroundColor: "#E8F8F8",
            borderRadius: "6px",
            border: "1px solid #00CED1",
            textAlign: "center"
          }}>
            <div style={{ fontSize: "12px", color: "#006666", marginBottom: "4px" }}>
              Selected: <b>{activeSegments.length} segment{activeSegments.length > 1 ? 's' : ''}</b>
            </div>
            <div style={{ fontSize: "15px", fontWeight: "bold", color: "#008B8B" }}>
              Total: {activeSegments.reduce((sum, id) => sum + (segmentLengths[id] || 0), 0).toFixed(1)} m
            </div>
            <button
              onClick={() => setActiveSegments([])}
              style={{
                marginTop: "8px",
                padding: "4px 12px",
                border: "none",
                borderRadius: "4px",
                backgroundColor: "#008B8B",
                color: "white",
                cursor: "pointer",
                fontSize: "11px"
              }}
            >
              Clear All
            </button>
          </div>
        )}
      </div>

      {/* Progress Counter - Top Center */}
      <div style={{
        position: "absolute",
        top: "10px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        backgroundColor: "white",
        padding: "8px 15px",
        borderRadius: "6px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        fontFamily: "Arial, sans-serif",
        fontSize: "12px",
        display: "flex",
        gap: "12px",
        alignItems: "center"
      }}>
        {/* Title */}
        <div style={{ fontWeight: "600", fontSize: "13px", color: "#333" }}>
          MV Cable Pulling Progress Tracking
        </div>
        
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        
        {/* Undo Button */}
        <button
          onClick={handleUndo}
          disabled={history.length === 0}
          title="Undo (Ctrl+Z)"
          style={{
            width: "28px",
            height: "28px",
            border: "none",
            borderRadius: "4px",
            backgroundColor: history.length === 0 ? "#e0e0e0" : "#f0f0f0",
            cursor: history.length === 0 ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background-color 0.2s"
          }}
          onMouseEnter={(e) => { if (history.length > 0) e.target.style.backgroundColor = "#ddd"; }}
          onMouseLeave={(e) => { if (history.length > 0) e.target.style.backgroundColor = "#f0f0f0"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={history.length === 0 ? "#999" : "#333"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v6h6"/>
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
          </svg>
        </button>
        
        {/* Redo Button */}
        <button
          onClick={handleRedo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Y)"
          style={{
            width: "28px",
            height: "28px",
            border: "none",
            borderRadius: "4px",
            backgroundColor: redoStack.length === 0 ? "#e0e0e0" : "#f0f0f0",
            cursor: redoStack.length === 0 ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background-color 0.2s"
          }}
          onMouseEnter={(e) => { if (redoStack.length > 0) e.target.style.backgroundColor = "#ddd"; }}
          onMouseLeave={(e) => { if (redoStack.length > 0) e.target.style.backgroundColor = "#f0f0f0"; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={redoStack.length === 0 ? "#999" : "#333"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 7v6h-6"/>
            <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
          </svg>
        </button>
        
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        
        {/* Submit Button */}
        <button
          onClick={() => setSubmitModalOpen(true)}
          title="Submit Daily Work"
          style={{
            padding: "5px 10px",
            border: "none",
            borderRadius: "4px",
            backgroundColor: "#0066cc",
            color: "white",
            cursor: "pointer",
            fontSize: "11px",
            fontWeight: "500",
            transition: "background-color 0.2s"
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#0055aa"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "#0066cc"}
        >
          📝 Submit
        </button>
        
        {/* History Button */}
        <button
          onClick={() => setHistoryModalOpen(true)}
          title="View History"
          style={{
            padding: "5px 10px",
            border: "none",
            borderRadius: "4px",
            backgroundColor: "#666",
            color: "white",
            cursor: "pointer",
            fontSize: "11px",
            fontWeight: "500",
            transition: "background-color 0.2s"
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = "#555"}
          onMouseLeave={(e) => e.target.style.backgroundColor = "#666"}
        >
          📋 History
        </button>
        
        {/* Export Button */}
        <button
          onClick={() => exportToExcel(dailyLog, totalLength)}
          disabled={isExporting || dailyLog.length === 0}
          title="Export to Excel"
          style={{
            padding: "5px 10px",
            border: "none",
            borderRadius: "4px",
            backgroundColor: (isExporting || dailyLog.length === 0) ? "#ccc" : "#228B22",
            color: "white",
            cursor: (isExporting || dailyLog.length === 0) ? "not-allowed" : "pointer",
            fontSize: "11px",
            fontWeight: "500",
            transition: "background-color 0.2s"
          }}
          onMouseEnter={(e) => { if (!isExporting && dailyLog.length > 0) e.target.style.backgroundColor = "#1a6b1a"; }}
          onMouseLeave={(e) => { if (!isExporting && dailyLog.length > 0) e.target.style.backgroundColor = "#228B22"; }}
        >
          {isExporting ? "⏳..." : "📊 Export"}
        </button>
        
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "10px", color: "#666" }}>Total</div>
          <div style={{ fontWeight: "600", fontSize: "13px" }}>{totalLength.toFixed(1)} m</div>
        </div>
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "10px", color: "#666" }}>Completed</div>
          <div style={{ fontWeight: "600", fontSize: "13px", color: "#00aa00" }}>{completedLength.toFixed(1)} m</div>
        </div>
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "10px", color: "#666" }}>Progress</div>
          <div style={{ fontWeight: "600", fontSize: "13px", color: "#0066cc" }}>{completedPercentage}%</div>
        </div>
        <div style={{ width: "1px", height: "24px", backgroundColor: "#ddd" }}></div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "10px", color: "#666" }}>Remaining</div>
          <div style={{ fontWeight: "600", fontSize: "13px", color: "#cc6600" }}>{remainingLength.toFixed(1)} m</div>
        </div>
      </div>

      {/* Legend */}
      <div style={{
        position: "absolute",
        top: "80px",
        right: "10px",
        zIndex: 1000,
        backgroundColor: "white",
        padding: "12px 16px",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        fontFamily: "Arial, sans-serif",
        fontSize: "13px"
      }}>
        <div style={{ fontWeight: "600", marginBottom: "10px", color: "#333" }}>Legend</div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <div style={{
            width: "32px",
            height: "4px",
            backgroundColor: "#D4A017",
            borderRadius: "2px"
          }}></div>
          <span style={{ color: "#555" }}>MV Cable Route</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <div style={{
            width: "32px",
            height: "5px",
            backgroundColor: "#2ECC71",
            borderRadius: "2px"
          }}></div>
          <span style={{ color: "#555" }}>Completed</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <div style={{
            width: "32px",
            height: "6px",
            backgroundColor: "#00CED1",
            borderRadius: "2px"
          }}></div>
          <span style={{ color: "#555" }}>Selected Segment</span>
        </div>
        <div style={{ marginTop: "10px", borderTop: "1px solid #eee", paddingTop: "10px" }}>
          <button
            onClick={() => setShowText(!showText)}
            title={showText ? "Hide Text Labels" : "Show Text Labels"}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: showText ? "#9b59b6" : "#f0f0f0",
              color: showText ? "white" : "#333",
              cursor: "pointer",
              fontWeight: "bold",
              transition: "background-color 0.2s"
            }}
          >
            {showText ? "🔤 Text On" : "🔤 Text Off"}
          </button>
        </div>
        <div style={{ marginTop: "10px", borderTop: "1px solid #eee", paddingTop: "10px" }}>
          <a
            href="https://drive.google.com/file/d/17AP0CXm6aLjLTZE3GlPvC6fYEkPV2M4M/view?usp=drive_link"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              width: "100%",
              padding: "8px 12px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: "#3498db",
              color: "white",
              cursor: "pointer",
              fontWeight: "bold",
              textAlign: "center",
              textDecoration: "none",
              fontSize: "12px",
              transition: "background-color 0.2s",
              boxSizing: "border-box"
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = "#2980b9"}
            onMouseLeave={(e) => e.target.style.backgroundColor = "#3498db"}
          >
            📐 View Original AutoCAD
          </a>
        </div>
        <div style={{ marginTop: "10px", borderTop: "1px solid #eee", paddingTop: "10px" }}>
          <button
            onClick={() => {
              setIsAddingNote(!isAddingNote);
              if (isAddingNote) {
                setPendingNotePosition(null);
                setNoteText('');
              }
            }}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: isAddingNote ? "#e74c3c" : "#f39c12",
              color: "white",
              cursor: "pointer",
              fontWeight: "bold",
              transition: "background-color 0.2s",
              fontSize: "12px"
            }}
          >
            {isAddingNote ? "❌ Cancel Note" : "📌 Add Note"}
          </button>
          {isAddingNote && !pendingNotePosition && (
            <div style={{ marginTop: "8px", fontSize: "11px", color: "#e74c3c", textAlign: "center" }}>
              👆 Click on the map to place your note
            </div>
          )}
        </div>
      </div>
      <MapContainer
        whenCreated={(map) => { mapRef.current = map; }}
        center={[52.685, -1.669]}
        zoom={18}
        style={{ height: "100%", width: "100%" }}
        zoomControl={false}
      >
        <NoteClickHandler />
        <SelectionBox 
          onSelectionComplete={handleSelectionComplete}
          onUnselectionComplete={handleUnselectionComplete}
          visibleLayersRef={visibleLayersRef}
          geoJsonData={geoJsonData}
          setSelectedBounds={setSelectedBounds}
          selectedSegments={selectedSegments}
          setSelectedSegments={setSelectedSegments}
        />
        {geoJsonData.poli && (
          <GeoJSON
            key="poli-layer"
            data={geoJsonData.poli}
            style={poliStyle}
          />
        )}
        {geoJsonData.trench && (
          <GeoJSON
            key="trench-layer"
            data={geoJsonData.trench}
            style={trenchLineStyle}
            onEachFeature={onEachTrenchLineFeature}
          />
        )}
        {/* Highlighted segment - outer cyan ring */}
        {highlightedSegmentGeoJson() && (
          <GeoJSON
            key={`highlighted-outer-${activeSegments.join('-')}`}
            data={highlightedSegmentGeoJson()}
            style={highlightedSegmentStyle}
            onEachFeature={onEachHighlightedFeature}
          />
        )}
        {/* Highlighted segment - inner green for completed parts */}
        {highlightedSegmentGeoJson() && (
          <GeoJSON
            key={`highlighted-inner-${activeSegments.join('-')}`}
            data={highlightedSegmentGeoJson()}
            style={highlightedCompletedInnerStyle}
            onEachFeature={onEachHighlightedInnerFeature}
          />
        )}
        {selectedGeoJson() && (
          <GeoJSON
            key={`selected-${selectedSegments.length}-${completedLength}`}
            data={selectedGeoJson()}
            style={greenLineStyle}
          />
        )}
        {geoJsonData.text && showText && geoJsonData.text.features.map((feature, index) => {
          if (feature.geometry.type === 'Point' && feature.properties.text) {
            const [lng, lat] = feature.geometry.coordinates;
            return (
              <Marker
                key={index}
                position={[lat, lng]}
                icon={createTextIcon(feature.properties.text)}
              />
            );
          }
          return null;
        })}

        {/* Saved Notes - Red Dots */}
        {savedNotes.map((note) => (
          <Marker
            key={note.id}
            position={note.position}
            icon={new DivIcon({
              className: 'note-marker',
              html: `<div style="
                width: 14px;
                height: 14px;
                background-color: #e74c3c;
                border-radius: 50%;
                border: 2px solid white;
                box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                cursor: pointer;
              "></div>`,
              iconSize: [14, 14],
              iconAnchor: [7, 7]
            })}
            eventHandlers={{
              click: () => handleNoteClick(note)
            }}
          />
        ))}

      </MapContainer>
      
      {/* Note Input Modal */}
      {pendingNotePosition && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'white',
          padding: '20px',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          zIndex: 2000,
          width: '300px'
        }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#333' }}>📌 Add Note</h3>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Enter your note..."
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              fontSize: '14px',
              resize: 'vertical',
              minHeight: '80px',
              boxSizing: 'border-box'
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px', justifyContent: 'flex-end' }}>
            <button
              onClick={handleNoteCancel}
              style={{
                padding: '8px 16px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                backgroundColor: '#f5f5f5',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleNoteSubmit}
              disabled={!noteText.trim()}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderRadius: '6px',
                backgroundColor: noteText.trim() ? '#e74c3c' : '#ccc',
                color: 'white',
                cursor: noteText.trim() ? 'pointer' : 'not-allowed',
                fontWeight: 'bold'
              }}
            >
              ✓ Save Note
            </button>
          </div>
        </div>
      )}

      {/* Edit Note Modal */}
      {editingNote && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'white',
          padding: '20px',
          borderRadius: '12px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          zIndex: 2000,
          width: '320px'
        }}>
          <h3 style={{ margin: '0 0 15px 0', color: '#333', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ 
              width: '12px', 
              height: '12px', 
              backgroundColor: '#e74c3c', 
              borderRadius: '50%',
              display: 'inline-block'
            }}></span>
            Edit Note
          </h3>
          <div style={{ fontSize: '11px', color: '#999', marginBottom: '10px' }}>
            📅 {new Date(editingNote.date).toLocaleDateString('en-US', { 
              year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            })}
          </div>
          <textarea
            value={editNoteText}
            onChange={(e) => setEditNoteText(e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              fontSize: '14px',
              resize: 'vertical',
              minHeight: '80px',
              boxSizing: 'border-box'
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '15px', justifyContent: 'space-between' }}>
            <button
              onClick={() => handleNoteDelete(editingNote.id)}
              style={{
                padding: '8px 16px',
                border: 'none',
                borderRadius: '6px',
                backgroundColor: '#ff4444',
                color: 'white',
                cursor: 'pointer',
                fontWeight: 'bold'
              }}
            >
              🗑️ Delete
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleEditCancel}
                style={{
                  padding: '8px 16px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  backgroundColor: '#f5f5f5',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleNoteUpdate}
                disabled={!editNoteText.trim()}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: editNoteText.trim() ? '#27ae60' : '#ccc',
                  color: 'white',
                  cursor: editNoteText.trim() ? 'pointer' : 'not-allowed',
                  fontWeight: 'bold'
                }}
              >
                ✓ Update
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Submit Modal */}
      <SubmitModal
        isOpen={submitModalOpen}
        onClose={() => setSubmitModalOpen(false)}
        onSubmit={(record) => {
          addRecord(record);
          setLastMarkedLength(0); // Reset after submission
          setSubmitModalOpen(false);
        }}
        completedLength={completedLength}
        totalLength={totalLength}
        lastMarkedLength={lastMarkedLength}
      />
      
      {/* History Modal */}
      <HistoryModal
        isOpen={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        dailyLog={dailyLog}
        onDeleteRecord={deleteRecord}
        onResetLog={resetLog}
        onUpdateRecord={updateRecord}
        onExport={() => exportToExcel(dailyLog, totalLength)}
        isExporting={isExporting}
      />
    </div>
  );
}
