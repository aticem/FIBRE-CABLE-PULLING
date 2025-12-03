// src/components/HistoryModal.jsx
// Günlük kayıt geçmişi modalı

import React, { useState, useEffect, useRef } from "react";

export default function HistoryModal({ isOpen, onClose, dailyLog, onDeleteRecord, onResetLog, onUpdateRecord, onExport, isExporting }) {
  // Draggable state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const modalRef = useRef(null);

  // Reset position when modal opens
  useEffect(() => {
    if (isOpen) {
      setPosition({ x: 0, y: 0 });
    }
  }, [isOpen]);

  // Handle drag events
  const handleMouseDown = (e) => {
    if (e.target.closest('.modal-header')) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragStart]);

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Tarihe göre grupla
  const groupedByDate = dailyLog.reduce((acc, record) => {
    const date = record.date;
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(record);
    return acc;
  }, {});

  // Tarihleri sırala (en yeni en üstte)
  const sortedDates = Object.keys(groupedByDate).sort((a, b) => new Date(b) - new Date(a));

  const handleResetAll = () => {
    if (window.confirm('Are you sure you want to delete ALL records? This cannot be undone!')) {
      onResetLog();
      onClose();
    }
  };

  return (
    <div 
      onClick={handleBackdropClick}
      onMouseDown={handleMouseDown}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}
    >
      <div 
        ref={modalRef}
        style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: '0',
          width: '600px',
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)',
          transform: `translate(${position.x}px, ${position.y}px)`,
          userSelect: isDragging ? 'none' : 'auto'
        }}
      >
        {/* Draggable Header */}
        <div 
          className="modal-header"
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            padding: '16px 24px',
            borderBottom: '2px solid #0066cc',
            cursor: 'move',
            backgroundColor: '#f8f8f8',
            borderRadius: '12px 12px 0 0'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ margin: 0, color: '#333' }}>
              📜 Work History
            </h2>
            <span style={{ fontSize: '11px', color: '#999' }}>⋮⋮ drag to move</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {dailyLog.length > 0 && (
              <>
                <button
                  onClick={onExport}
                  disabled={isExporting}
                  style={{
                    padding: '6px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: isExporting ? '#ccc' : '#228B22',
                    color: 'white',
                    cursor: isExporting ? 'not-allowed' : 'pointer',
                    fontSize: '12px'
                  }}
                >
                  {isExporting ? '⏳ Exporting...' : '📊 Export Excel'}
                </button>
                <button
                  onClick={handleResetAll}
                  style={{
                    padding: '6px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: '#ff4444',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  🗑️ Clear All
                </button>
              </>
            )}
            <button
              onClick={onClose}
              style={{
                padding: '6px 12px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                backgroundColor: '#f5f5f5',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              ✕ Close
            </button>
          </div>
        </div>
        
        <div style={{ padding: '16px 24px', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Summary */}
        <div style={{
          backgroundColor: '#e3f2fd',
          padding: '12px 16px',
          borderRadius: '8px',
          marginBottom: '16px',
          display: 'flex',
          justifyContent: 'space-around'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '12px', color: '#1565c0' }}>Total Records</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#0d47a1' }}>{dailyLog.length}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '12px', color: '#1565c0' }}>Total Work</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#0d47a1' }}>
              {dailyLog.reduce((sum, r) => sum + (r.installed_length || 0), 0).toFixed(1)} m
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '12px', color: '#1565c0' }}>Total Workers</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#0d47a1' }}>
              {dailyLog.reduce((sum, r) => sum + (r.workers || 0), 0)}
            </div>
          </div>
        </div>
        
        {/* Records List */}
        <div style={{ 
          flex: 1, 
          overflowY: 'auto',
          border: '1px solid #eee',
          borderRadius: '8px'
        }}>
          {dailyLog.length === 0 ? (
            <div style={{ 
              padding: '40px', 
              textAlign: 'center', 
              color: '#999' 
            }}>
              No records yet. Submit your first daily work!
            </div>
          ) : (
            sortedDates.map(date => (
              <div key={date} style={{ borderBottom: '1px solid #eee' }}>
                {/* Date Header */}
                <div style={{
                  backgroundColor: '#f5f5f5',
                  padding: '8px 16px',
                  fontWeight: 'bold',
                  color: '#333',
                  fontSize: '14px',
                  position: 'sticky',
                  top: 0
                }}>
                  📅 {new Date(date).toLocaleDateString('en-US', { 
                    weekday: 'long', 
                    year: 'numeric', 
                    month: 'long', 
                    day: 'numeric' 
                  })}
                </div>
                
                {/* Records for this date */}
                {groupedByDate[date].map((record, idx) => (
                  <div 
                    key={record.id || idx}
                    style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid #f0f0f0',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: '20px', marginBottom: '4px' }}>
                        <span style={{ color: '#00aa00', fontWeight: 'bold' }}>
                          📏 {record.installed_length?.toFixed(2) || 0} m
                        </span>
                        <span style={{ color: '#666' }}>
                          👷 {record.workers || 0} workers
                        </span>
                        <span style={{ color: '#9c27b0' }}>
                          🏢 {record.subcontractor || '-'}
                        </span>
                      </div>
                      {record.notes && (
                        <div style={{ fontSize: '12px', color: '#999', fontStyle: 'italic' }}>
                          📝 {record.notes}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        if (window.confirm('Delete this record?')) {
                          onDeleteRecord(record.id);
                        }
                      }}
                      style={{
                        padding: '4px 8px',
                        border: 'none',
                        borderRadius: '4px',
                        backgroundColor: '#ffebee',
                        color: '#c62828',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
