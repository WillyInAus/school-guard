-- Test seed for scripts/tests/*.test.js (local test database only).
INSERT INTO staff_users (name,email,password_hash,role) VALUES ('Admin A','a@x','x','admin'),('Approver B','b@x','x','approver'),('Teacher T','t@x','x','submitter'),('Other O','o@x','x','submitter');
INSERT INTO rooms (name) VALUES ('IDT Workshop'),('Outdoor construction area');
INSERT INTO pera_records (activity_name,class_unit,risk_level,status,supervision_level) VALUES
 ('Brick saw — Plant & Equipment Risk Assessment','Construction','High','Approved','Direct supervision'),
 ('Concrete mixer — Plant & Equipment Risk Assessment','Construction','Medium','Approved','General supervision'),
 ('Hand tools — Plant & Equipment Risk Assessment','General','Low','Approved','General supervision'),
 ('Pedestal drill — Plant & Equipment Risk Assessment','Metalwork','High','Approved','Direct supervision');
INSERT INTO pera_hazards (pera_id,description,control_measure,mandatory) VALUES (1,'Silica dust from cutting','Wet cutting only; P2 respirator',true),(2,'Entanglement','Guards in place',true);
INSERT INTO cara_records (activity_name,class_unit,course,risk_level,status,students_notes,activity_scope,created_by_staff_id,year_level,class_size)
 VALUES ('Cert II Construction','Construction','CPC20220 Certificate II in Construction Pathways','High','Draft','SECRET-STUDENT-XYZ medical plan for J. Smith','Students build practice projects.',3,'Year 11',14),
        ('Old approved CARA','Woodwork',null,'Medium','Approved','other secret','Approved scope',3,null,null),
        ('Vet Engineering CERT II','Grad','MEM20422 Certificate II in Engineering Pathways','High','Approved','x',
         'Students undertake supervised practical work.',3,'[Year level]',null);
UPDATE cara_records SET emergency_first_aid = E'- First aid kit is located in the [location].\n- For severe burns, apply cool water or ice.\n- Refer to [AS/NZS 1336] for eye protection.',
  supervision_notes = E'All equipment other than low-risk hand tools requires direct supervision for each use.\nStudents may use power drills under same-room supervision once inducted.',
  induction_instruction = 'Students complete [school''s induction process] before practical work.', approver = 'Approver B', approved_at = now() WHERE id = 3;
INSERT INTO cara_change_log (cara_id, changed_by, summary, brief) VALUES (3, 'Teacher T', E'Emergency and first aid: (empty) → - For severe burns, apply cool water or ice.', 'Updated emergency and first aid');
INSERT INTO cara_tool_links (cara_id,pera_id) VALUES (1,3),(1,2),(3,4);
